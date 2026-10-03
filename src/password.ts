import { Effect, Schema } from "effect"
import { Op } from "./op.js"

const Item = Schema.Struct({
  id: Op.Id,
  title: Schema.String,
  category: Schema.String,
  vault: Schema.Struct({ id: Op.Id, name: Schema.String }),
  fields: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      type: Schema.String,
      purpose: Schema.optionalKey(Schema.String),
      value: Schema.optionalKey(Schema.String),
      section: Schema.optionalKey(Schema.Unknown),
    }),
  ),
})

export interface Options {
  readonly item: string
  readonly vault: string
  readonly account?: string | undefined
  readonly source: Op.Source
  readonly apply: boolean
  readonly repairImportedFields: boolean
}

const { fail } = Op

const builtInPasswords = (item: typeof Item.Type) =>
  item.fields.filter(
    (field) =>
      field.id === "password" &&
      field.purpose === "PASSWORD" &&
      field.type === "CONCEALED" &&
      field.section === undefined,
  )

// Rewrites the item template with the new password, preserving every other field.
// op's JSON edit cannot preserve passkeys, and unnamed imported fields need explicit repair.
const editedTemplate = (raw: string, password: string, repairImportedFields: boolean) =>
  Effect.try({
    try: () => {
      const value = JSON.parse(raw)
      if ((value.passkeys?.length ?? 0) > 0 || value.fields.some((field: { type: string }) => field.type === "PASSKEY"))
        throw new Error()
      for (const [index, field] of value.fields.entries()) {
        if (!field.id && !field.label) {
          if (!repairImportedFields) throw new Error()
          field.id = `imported_field_${index + 1}`
          field.label = `Imported field ${index + 1}`
          field.type = "CONCEALED"
        }
      }
      for (const field of value.fields)
        if (field.id === "password" && field.purpose === "PASSWORD" && field.section === undefined)
          field.value = password
      return JSON.stringify(value)
    },
    catch: () =>
      fail(
        "Cannot safely edit this login template: passkeys or unnamed imported fields require review; nothing was changed",
      ),
  })

export const password = Effect.fn("Password.password")(function* (options: Options) {
  if (!options.item.trim() || !options.vault.trim()) return yield* fail("An item and explicit vault are required")
  // Passwords are exact strings: unlike API-credential creation, never trim a newline.
  const input = yield* Op.privateInput(options.source, "password", "nothing was changed")
  const { account } = options
  const get = (id: string, vault: string, failure: string) =>
    Op.op(["item", "get", id, "--vault", vault, "--format", "json", "--reveal"], { account, failure })
  const decode = (raw: string, failure: string) =>
    Schema.decodeUnknownEffect(Schema.fromJsonString(Item))(raw).pipe(Effect.mapError(() => fail(failure)))

  const inspectFailure = "Could not inspect login; nothing was changed (1Password details suppressed)"
  const raw = yield* get(options.item, options.vault, inspectFailure)
  const item = yield* decode(raw, inspectFailure)
  const current = builtInPasswords(item)
  if (item.category !== "LOGIN" || current.length !== 1)
    return yield* fail("Expected a Login with exactly one built-in password; nothing was changed")
  const receipt = {
    id: item.id,
    title: item.title,
    vault: item.vault.name,
    ref: `op://${item.vault.id}/${item.id}/password`,
  }
  if (!options.apply) return { ...receipt, matches: current[0]?.value === input }
  if (current[0]?.value === input) return { ...receipt, changed: false, verified: true }

  const template = yield* editedTemplate(raw, input, options.repairImportedFields)
  const uncertain = "Password update is unverified; check this item before retrying (1Password details suppressed)"
  yield* Op.op(["item", "edit", item.id, "--vault", item.vault.id, "--format", "json"], {
    account,
    input: template,
    failure: `${uncertain}; edit request failed`,
  })
  const stored = yield* get(item.id, item.vault.id, `${uncertain}; read-back failed`).pipe(
    Effect.flatMap((text) => decode(text, `${uncertain}; read-back format invalid`)),
  )
  const passwords = builtInPasswords(stored)
  if (
    stored.id !== item.id ||
    stored.vault.id !== item.vault.id ||
    stored.title !== item.title ||
    stored.category !== item.category ||
    passwords.length !== 1 ||
    passwords[0]?.value !== input
  ) {
    return yield* fail(`${uncertain}; read-back did not match`)
  }
  return { ...receipt, changed: true, verified: true }
})

export * as Password from "./password.js"
