import { assert, describe, it } from "@effect/vitest"
import { join } from "node:path"
import { credential, itemId, notes, title, url, vaultId } from "./fixtures/create-process.js"
import { fixture, sandbox } from "./sandbox.js"

const destination = ["--title", title, "--vault", "Personal"]
const ref = `op://${vaultId}/${itemId}/credential`
const fake = fixture(join(import.meta.dirname, "fixtures/create-process.ts"))

const run = async (args: ReadonlyArray<string>, scenario = "success", input = `${credential}\n`) => {
  const box = await sandbox({ op: fake, pbpaste: fake, pbcopy: fake })
  try {
    const result = await box.run(["create", "api-credential", ...args], { input, env: { TEST_SCENARIO: scenario } })
    const calls = await box.calls()
    const observable = `${result.stdout}\n${result.stderr}\n${JSON.stringify(calls)}`
    for (const privateText of [
      credential,
      JSON.stringify(credential).slice(1, -1),
      "fictional-only",
      "second-line",
      "OTHER_PRIVATE_VALUE",
      "SECRET_LENGTH_SENTINEL",
      "SECRET_HASH_SENTINEL",
    ]) {
      assert.isFalse(observable.includes(privateText), "Private input leaked into output or subprocess arguments")
    }
    assert.isFalse(calls.some(({ command }) => command === "pbcopy"))
    assert.isFalse(calls.some((call) => call.args.includes("whoami")))
    return {
      ...result,
      calls,
      operations: calls.filter(({ command }) => command === "op").map((call) => call.args.slice(0, 2).join(" ")),
    }
  } finally {
    await box.close()
  }
}

describe("create api-credential", () => {
  it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "creates from a mocked clipboard and verifies without changing it",
    async () => {
      const result = await run([...destination, "--clipboard"])
      assert.strictEqual(result.code, 0)
      assert.strictEqual(result.stderr, "")
      assert.deepStrictEqual(JSON.parse(result.stdout), {
        id: itemId,
        title,
        vault: "Personal",
        kind: "api-credential",
        field: "credential",
        ref,
        verified: true,
      })
      assert.deepStrictEqual(
        result.calls.map(({ command }) => command),
        ["pbpaste", "op", "op", "template-verified", "op"],
      )
      assert.deepStrictEqual(result.operations, ["item list", "item create", "item get"])
    },
  )

  it("pipes stdin JSON, forwards account scope, and verifies website/notes", async () => {
    const result = await run(
      [...destination, "--stdin", "--account", "example.1password.com", "--url", url, "--notes", notes],
      "options",
      `${credential}\r\n`,
    )
    assert.strictEqual(result.code, 0)
    assert.strictEqual(result.stderr, "")
    assert.strictEqual(JSON.parse(result.stdout).verified, true)
    assert.isFalse(result.stdout.includes(notes))
    assert.isFalse(result.stdout.includes(url))
    assert.deepStrictEqual(
      result.calls.filter(({ command }) => command === "op").map(({ args }) => args),
      [
        ["item", "list", "--vault", "Personal", "--format", "json", "--account", "example.1password.com"],
        ["item", "create", "-", "--vault", "Personal", "--format", "json", "--account", "example.1password.com"],
        [
          "item",
          "get",
          itemId,
          "--vault",
          vaultId,
          "--format",
          "json",
          "--reveal",
          "--account",
          "example.1password.com",
        ],
      ],
    )
    assert.isFalse(result.calls.some(({ command }) => command === "pbpaste"))
  })

  it("accepts a vault ID and stdin without a terminal newline", async () => {
    const result = await run(["--title", title, "--vault", vaultId, "--stdin"], "success", credential)
    assert.strictEqual(result.code, 0)
    assert.strictEqual(JSON.parse(result.stdout).ref, ref)
  })

  for (const flags of [[], ["--clipboard", "--stdin"]]) {
    it(`requires exactly one input source (${flags.join(" ") || "neither"})`, async () => {
      const result = await run([...destination, ...flags])
      assert.notStrictEqual(result.code, 0)
      assert.match(result.stderr, /Choose exactly one of --clipboard or --stdin/)
      assert.deepStrictEqual(result.calls, [])
    })
  }

  for (const args of [
    ["--title", title],
    ["--vault", "Personal"],
    ["--title", "  ", "--vault", "Personal"],
    ["--title", title, "--vault", "  "],
  ]) {
    it(`rejects missing/blank destination before reading input (${JSON.stringify(args)})`, async () => {
      const result = await run([...args, "--clipboard"])
      assert.notStrictEqual(result.code, 0)
      assert.deepStrictEqual(result.calls, [])
    })
  }

  for (const input of ["", " \t\r\n"]) {
    it(`rejects empty/blank stdin (${JSON.stringify(input)})`, async () => {
      const result = await run([...destination, "--stdin"], "success", input)
      assert.notStrictEqual(result.code, 0)
      assert.match(result.stderr, /input is empty/)
      assert.deepStrictEqual(result.operations, [])
    })
  }

  for (const scenario of ["clipboard-error", "clipboard-empty"]) {
    it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
      `fails safely on ${scenario}`,
      async () => {
        const result = await run([...destination, "--clipboard"], scenario)
        assert.notStrictEqual(result.code, 0)
        assert.strictEqual(result.stdout, "")
        assert.match(result.stderr, /nothing was created/)
        assert.deepStrictEqual(
          result.calls.map(({ command }) => command),
          ["pbpaste"],
        )
      },
    )
  }

  it("refuses duplicate titles regardless of case or surrounding whitespace", async () => {
    const result = await run([...destination, "--stdin"], "duplicate")
    assert.notStrictEqual(result.code, 0)
    assert.match(result.stderr, /already exists/)
    assert.deepStrictEqual(result.operations, ["item list"])
  })

  for (const scenario of ["list-error", "list-json"]) {
    it(`does not create after ${scenario}`, async () => {
      const result = await run([...destination, "--stdin"], scenario)
      assert.notStrictEqual(result.code, 0)
      assert.strictEqual(result.stdout, "")
      assert.match(result.stderr, /nothing was created/)
      assert.deepStrictEqual(result.operations, ["item list"])
    })
  }

  for (const scenario of ["create-error", "create-json", "receipt-id", "receipt-vault"]) {
    it(`reports uncertain persistence without retrying on ${scenario}`, async () => {
      const result = await run([...destination, "--stdin"], scenario)
      assert.notStrictEqual(result.code, 0)
      assert.strictEqual(result.stdout, "")
      assert.match(result.stderr, /Do not retry creation/)
      assert.deepStrictEqual(result.operations, ["item list", "item create"])
    })
  }

  for (const scenario of [
    "read-error",
    "read-json",
    "value-mismatch",
    "type-mismatch",
    "field-mismatch",
    "section-mismatch",
    "missing-field",
    "duplicate-field",
    "id-mismatch",
    "vault-mismatch",
    "category-mismatch",
    "title-mismatch",
    "notes-mismatch",
    "url-mismatch",
  ]) {
    it(`does not claim verification or retry after ${scenario}`, async () => {
      const options =
        scenario === "notes-mismatch" || scenario === "url-mismatch" ? ["--notes", notes, "--url", url] : []
      const result = await run([...destination, "--stdin", ...options, "--log-level", "debug"], scenario)
      assert.notStrictEqual(result.code, 0)
      assert.strictEqual(result.stdout, "")
      assert.match(result.stderr, /Creation is unverified.*Do not retry creation/)
      assert.include(result.stderr, ref)
      assert.deepStrictEqual(result.operations, ["item list", "item create", "item get"])
    })
  }

  it("documents the required destination and private input flags without invoking subprocesses", async () => {
    const result = await run(["--help"])
    assert.strictEqual(result.code, 0)
    for (const flag of ["--title", "--vault", "--clipboard", "--stdin", "--account", "--url", "--notes"])
      assert.include(result.stdout, flag)
    assert.deepStrictEqual(result.calls, [])
  })
})
