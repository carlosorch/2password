import { assert, describe, it } from "@effect/vitest"
import { join } from "node:path"
import { fixture, sandbox } from "./sandbox.js"

const fake = fixture(join(import.meta.dirname, "fixtures/password-process.ts"))

const run = async (apply: boolean, scenario = "success") => {
  const box = await sandbox({ op: fake, pbpaste: fake })
  try {
    const result = await box.run(
      ["password", "a".repeat(26), "--vault", "Personal", "--stdin", ...(apply ? ["--apply"] : [])],
      {
        input: "FICTIONAL-PASSWORD-ONLY\n",
        env: { TEST_SCENARIO: scenario },
      },
    )
    const calls = await box.calls()
    const observable = result.stdout + result.stderr + JSON.stringify(calls)
    for (const secret of ["FICTIONAL-PASSWORD-ONLY", "OLD-PRIVATE-VALUE", "WRONG-PRIVATE-VALUE", "FICTIONAL-PASSKEY"])
      assert.notInclude(observable, secret)
    return { ...result, operations: calls.map(({ args }) => args.slice(0, 2).join(" ")) }
  } finally {
    await box.close()
  }
}

describe("password", () => {
  it("compares without modifying a login or exposing either value", async () => {
    const result = await run(false)
    assert.strictEqual(result.code, 0)
    assert.strictEqual(JSON.parse(result.stdout).matches, false)
    assert.deepStrictEqual(result.operations, ["item get"])
  })
  it("preserves exact input and unrelated template fields and verifies the stored password", async () => {
    const result = await run(true)
    assert.strictEqual(result.code, 0)
    assert.strictEqual(JSON.parse(result.stdout).verified, true)
    assert.deepStrictEqual(result.operations, ["item get", "item edit", "item get"])
  })
  for (const scenario of ["passkey", "invalid-json"])
    it(`refuses writes on ${scenario}`, async () => {
      const result = await run(true, scenario)
      assert.notStrictEqual(result.code, 0)
      assert.deepStrictEqual(result.operations, ["item get"])
    })
  for (const scenario of ["edit-error", "read-error", "mismatch"])
    it(`reports unverified persistence without retrying after ${scenario}`, async () => {
      const result = await run(true, scenario)
      assert.notStrictEqual(result.code, 0)
      assert.include(result.stderr, "unverified")
      assert.strictEqual(result.stdout, "")
      assert.strictEqual(result.operations.filter((op) => op === "item edit").length, 1)
    })
})
