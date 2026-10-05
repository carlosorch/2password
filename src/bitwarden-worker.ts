import { stdin } from "bun"

// Isolate SDK diagnostics from the CLI. Tokens and write values cross stdin only.
// stdout is a private pipe consumed by the parent, never attached to the terminal.
try {
  const request = JSON.parse(await stdin.text())
  const { BitwardenClient } = await import("@bitwarden/sdk-napi")
  const client = new BitwardenClient(undefined, 4)
  await client.auth().loginAccessToken(request.token)
  const secrets = client.secrets()
  let result: unknown
  switch (request.operation) {
    case "list":
      result = await secrets.list(request.organization)
      break
    case "get":
      result = await secrets.get(request.id)
      break
    case "getByIds":
      result = await secrets.getByIds(request.ids)
      break
    case "create":
      result = await secrets.create(request.organization, request.key, request.value, request.note, [request.project])
      break
    case "update":
      result = await secrets.update(request.organization, request.id, request.key, request.value, request.note, [
        request.project,
      ])
      break
    default:
      throw new Error("Unsupported operation")
  }
  process.stdout.write(JSON.stringify(result))
} catch {
  // SDK errors can include credentials or server responses. Never forward them.
  process.exitCode = 1
}
