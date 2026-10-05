import { afterEach, describe, expect, it } from "vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { sandbox, type Sandbox } from "./sandbox.js"

const id = "33333333-3333-3333-3333-333333333333"
let stand: Sandbox | undefined
const setup = async () => {
  stand = await sandbox({})
  return stand
}
afterEach(async () => {
  await stand?.close()
  stand = undefined
})

describe("Bitwarden CLI without live credentials", () => {
  it("doctor never authenticates, needs no op, and does not print a configured token", async () => {
    const env = await setup()
    const result = await env.run(["bitwarden", "doctor"], { env: { BWS_ACCESS_TOKEN: "FICTIONAL_TOKEN_NOT_PRINTED" } })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      sdkAvailable: true,
      tokenConfigured: true,
      authenticationAttempted: false,
    })
    expect(result.stdout + result.stderr).not.toContain("FICTIONAL_TOKEN_NOT_PRINTED")
    expect(await env.calls()).toEqual([])
  })
  it("fails closed without a token and never executes the selected child", async () => {
    const env = await setup()
    const result = await env.run(["bitwarden", "run", "--env", `KEY=bws://${id}`, "--", "nonexistent-child"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("details suppressed")
    expect(result.stdout).toBe("")
    expect(await env.calls()).toEqual([])
  })
  it("writes reference-only templates and rejects plaintext templates", async () => {
    const env = await setup()
    const file = join(env.home, "keys.tpl")
    const result = await env.run(["bitwarden", "env", "write", file, `KEY=bws://${id}`])
    expect(result.code).toBe(0)
    expect(await readFile(file, "utf8")).toBe(`KEY=bws://${id}\n`)
    const rejected = await env.run(["bitwarden", "env", "write", file, "KEY=FICTIONAL_SECRET"])
    expect(rejected.code).not.toBe(0)
    // Flag parser diagnostics may repeat input: reference-only flags must never receive plaintext.
    expect(await readFile(file, "utf8")).toBe(`KEY=bws://${id}\n`)
  })
  it("requires exactly one private source for writes", async () => {
    const env = await setup()
    const result = await env.run(["bitwarden", "create", "--organization", id, "--project", id, "--title", "Test"])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("Choose exactly one")
  })
})
