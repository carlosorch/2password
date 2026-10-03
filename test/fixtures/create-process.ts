import { appendFileSync, fstatSync, readFileSync } from "node:fs"

// Fictional inputs only. No fixture ever reads the system clipboard or invokes op.
export const credential = 'fictional-only-"credential"-\\-line\nsecond-line'
export const itemId = "aaaaaaaaaaaaaaaaaaaaaaaaaa"
export const vaultId = "bbbbbbbbbbbbbbbbbbbbbbbbbb"
export const title = "Example API Key"
export const notes = "Fixture operational context"
export const url = "https://example.invalid/api"

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  const scenario = process.env.TEST_SCENARIO
  const callsFile = process.env.TEST_CALLS
  if (callsFile === undefined) throw new Error("Mock calls path is required")
  const log = (event: unknown) => appendFileSync(callsFile, `${JSON.stringify(event)}\n`)
  log({ command, args })

  const fail = () => {
    // Deliberately hostile op output must not escape through errors or causes.
    const output = `${credential} OTHER_PRIVATE_VALUE SECRET_LENGTH_SENTINEL SECRET_HASH_SENTINEL`
    process.stdout.write(output)
    process.stderr.write(output)
    process.exit(71)
  }
  if (command === "pbpaste") {
    if (scenario === "clipboard-error") fail()
    process.stdout.write(scenario === "clipboard-empty" ? " \r\n" : `${credential}\r\n`)
  } else if (command === "op") {
    const operation = args.slice(0, 2).join(" ")
    if (operation === "item list") {
      if (scenario === "list-error") fail()
      process.stdout.write(
        scenario === "list-json"
          ? credential
          : JSON.stringify(scenario === "duplicate" ? [{ title: "  EXAMPLE api KEY  " }] : []),
      )
    } else if (operation === "item create" || operation === "item get") {
      const withOptions = scenario === "options" || scenario === "notes-mismatch" || scenario === "url-mismatch"
      const expected = {
        title,
        category: "API_CREDENTIAL",
        fields: [
          { id: "credential", type: "CONCEALED", label: "credential", value: credential },
          ...(withOptions
            ? [{ id: "notesPlain", type: "STRING", purpose: "NOTES", label: "notesPlain", value: notes }]
            : []),
        ],
        ...(withOptions ? { urls: [{ href: url, primary: true }] } : {}),
      }
      if (operation === "item create") {
        const input = readFileSync(0, "utf8")
        if (!fstatSync(0).isFIFO() || JSON.stringify(JSON.parse(input)) !== JSON.stringify(expected)) {
          process.stderr.write("Mock JSON template/pipe contract failed")
          process.exit(72)
        }
        log({ command: "template-verified", args: [] })
      }
      if (scenario === (operation === "item create" ? "create-error" : "read-error")) fail()
      if (scenario === (operation === "item create" ? "create-json" : "read-json")) {
        process.stdout.write(credential)
        process.exit(0)
      }
      const item = {
        ...expected,
        id: itemId,
        vault: { id: vaultId, name: "Personal" },
        // Neither op-supplied refs nor unrelated metadata should be trusted/output.
        reference: credential,
        private: "OTHER_PRIVATE_VALUE",
        secretLength: "SECRET_LENGTH_SENTINEL",
        secretHash: "SECRET_HASH_SENTINEL",
      }
      if (operation === "item create" && scenario === "receipt-id") item.id = credential
      if (operation === "item create" && scenario === "receipt-vault") item.vault.name = "Unexpected"
      if (operation === "item get") {
        if (scenario === "value-mismatch") item.fields[0].value = "OTHER_PRIVATE_VALUE"
        if (scenario === "type-mismatch") item.fields[0].type = "STRING"
        if (scenario === "field-mismatch") item.fields[0].id = "apiKey"
        if (scenario === "section-mismatch") Object.assign(item.fields[0], { section: { id: "custom" } })
        if (scenario === "missing-field") item.fields = []
        if (scenario === "duplicate-field") item.fields.push(item.fields[0])
        if (scenario === "id-mismatch") item.id = "cccccccccccccccccccccccccc"
        if (scenario === "vault-mismatch") item.vault.id = "cccccccccccccccccccccccccc"
        if (scenario === "category-mismatch") item.category = "LOGIN"
        if (scenario === "title-mismatch") item.title = credential
        if (scenario === "notes-mismatch") item.fields[1].value = "OTHER_PRIVATE_VALUE"
        if (scenario === "url-mismatch") item.urls = []
      }
      // Successful subprocesses can also emit sensitive diagnostics.
      process.stderr.write(credential)
      process.stdout.write(JSON.stringify(item))
    } else {
      // whoami, retries, edits, and all unexpected operations fail closed.
      fail()
    }
  } else {
    // Includes pbcopy: tests must never clear or alter a clipboard.
    fail()
  }
}
