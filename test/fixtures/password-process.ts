import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"

const secret = "FICTIONAL-PASSWORD-ONLY\n"
const [command, ...args] = process.argv.slice(2)
const calls = process.env.TEST_CALLS!
const state = `${calls}.state`
const scenario = process.env.TEST_SCENARIO
appendFileSync(calls, JSON.stringify({ command, args }) + "\n")
if (command === "pbpaste") {
  process.stdout.write(secret)
  process.exit(0)
}
const item = {
  id: "a".repeat(26),
  title: "Example Airline",
  category: "LOGIN",
  vault: { id: "b".repeat(26), name: "Personal" },
  fields: [
    {
      id: "password",
      purpose: "PASSWORD",
      type: "CONCEALED",
      value: existsSync(state) ? readFileSync(state, "utf8") : "OLD-PRIVATE-VALUE",
    },
    { id: "username", purpose: "USERNAME", type: "STRING", value: "example-user" },
  ],
  urls: [{ href: "https://example.com", primary: true }],
  customProperty: { preserve: true },
  ...(scenario === "passkey" ? { passkeys: [{ credentialId: "FICTIONAL-PASSKEY" }] } : {}),
}
if (args[1] === "edit") {
  const template = await Bun.stdin.json()
  if (
    template.fields[0].value !== secret ||
    template.fields[1].value !== "example-user" ||
    !template.customProperty.preserve ||
    template.urls[0].href !== "https://example.com"
  )
    process.exit(4)
  writeFileSync(state, scenario === "mismatch" ? "WRONG-PRIVATE-VALUE" : template.fields[0].value)
  if (scenario === "edit-error") {
    console.error(secret)
    process.exit(2)
  }
  process.stdout.write(JSON.stringify(template))
} else if (args[1] === "get") {
  if (scenario === "read-error" && existsSync(state)) {
    console.error(secret)
    process.exit(3)
  }
  if (scenario === "invalid-json") process.stdout.write(secret)
  else process.stdout.write(JSON.stringify(item))
} else process.exit(5)
