import { Effect, Redacted, Schema } from "effect"
import { Op } from "./op.js"

export interface Destination {
  readonly title: string
  readonly vault: string
  readonly account?: string | undefined
  readonly url?: string | undefined
  readonly notes?: string | undefined
}

// Only validated IDs, never op's arbitrary reference strings, may reach output.
const Receipt = Schema.Struct({
  id: Op.Id,
  title: Schema.String,
  category: Schema.String,
  vault: Schema.Struct({ id: Op.Id, name: Schema.String }),
})
const StoredItem = Schema.Struct({
  ...Receipt.fields,
  urls: Schema.optionalKey(Schema.Array(Schema.Struct({ href: Schema.String }))),
  fields: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      value: Schema.optionalKey(Schema.String),
      section: Schema.optionalKey(Schema.Unknown),
    }),
  ),
})

const { fail } = Op

// Case-insensitive and whitespace-tolerant. Not an atomic lock against concurrent writers.
export const titleTaken = Effect.fn("Create.titleTaken")(function* (
  vault: string,
  title: string,
  account: string | undefined,
  failure: string,
) {
  const items = yield* Op.json(
    Schema.Array(Schema.Struct({ title: Schema.String })),
    ["item", "list", "--vault", vault, "--format", "json"],
    { account, failure },
  )
  return items.some((item) => item.title.trim().toLowerCase() === title.toLowerCase())
})

export const apiCredential = Effect.fn("Create.apiCredential")(function* (destination: Destination, source: Op.Source) {
  const title = destination.title.trim()
  const vault = destination.vault.trim()
  if (!title || !vault) return yield* fail("A non-empty --title and explicit --vault are required")
  const input = yield* Op.privateInput(source, "credential", "nothing was created")
  // Strip one terminal line ending for pipe/clipboard convenience; other whitespace may be meaningful.
  return yield* storeApiCredential({ ...destination, title, vault }, Redacted.make(input.replace(/\r?\n$/, "")))
})

// Creates exactly once, then reads the item back and compares it before claiming success.
export const storeApiCredential = Effect.fn("Create.storeApiCredential")(function* (
  destination: Destination,
  value: Redacted.Redacted<string>,
) {
  const { title, vault, account, url, notes } = destination
  const credential = Redacted.value(value)
  if (!title.trim() || !vault.trim() || !credential.trim())
    return yield* fail("A title, explicit vault, and non-empty credential are required; nothing was created")
  if (
    yield* titleTaken(
      vault,
      title,
      account,
      "Could not check for an existing title; nothing was created (1Password details suppressed)",
    )
  ) {
    return yield* fail(
      "An item with this title already exists in the selected vault; nothing was created or overwritten. Use 2password find to inspect it",
    )
  }

  const template = JSON.stringify({
    title,
    category: "API_CREDENTIAL",
    fields: [
      { id: "credential", type: "CONCEALED", label: "credential", value: credential },
      ...(notes === undefined
        ? []
        : [{ id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: notes }]),
    ],
    ...(url === undefined ? {} : { urls: [{ href: url, primary: true }] }),
  })
  const receipt = yield* Op.json(Receipt, ["item", "create", "-", "--vault", vault, "--format", "json"], {
    account,
    input: template,
    failure:
      "Creation may have succeeded, but its receipt could not be verified. Do not retry creation; inspect the destination with 2password find first (1Password details suppressed)",
  })

  const ref = `op://${receipt.vault.id}/${receipt.id}/credential`
  const unverified = `Creation is unverified. Do not retry creation; inspect the destination by title with 2password find first. Item reference: ${ref} (1Password details suppressed)`
  if (
    receipt.title !== title ||
    receipt.category !== "API_CREDENTIAL" ||
    (receipt.vault.name !== vault && receipt.vault.id !== vault)
  ) {
    return yield* fail(unverified)
  }
  const stored = yield* Op.json(
    StoredItem,
    ["item", "get", receipt.id, "--vault", receipt.vault.id, "--format", "json", "--reveal"],
    {
      account,
      failure: unverified,
    },
  )
  const fields = stored.fields.filter((field) => field.id === "credential")
  const storedNotes = stored.fields.find((field) => field.id === "notesPlain" && field.section === undefined)
  const matches =
    stored.id === receipt.id &&
    stored.vault.id === receipt.vault.id &&
    stored.vault.name === receipt.vault.name &&
    stored.title === title &&
    stored.category === "API_CREDENTIAL" &&
    fields.length === 1 &&
    fields[0]?.type === "CONCEALED" &&
    fields[0]?.section === undefined &&
    fields[0]?.value === credential &&
    (notes === undefined || (storedNotes?.value ?? "") === notes) &&
    (url === undefined || stored.urls?.some(({ href }) => href === url) === true)
  if (!matches) return yield* fail(unverified)

  // Deliberately excludes field values, notes, URLs, and op's extra metadata.
  return { id: receipt.id, title, vault, kind: "api-credential", field: "credential", ref, verified: true }
})

export * as Create from "./create.js"
