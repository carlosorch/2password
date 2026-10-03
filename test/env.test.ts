import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { decodeTrailingArguments, normalizeTrailingArguments } from "../src/arguments"
import { parseAssignment, renderEnv, resolveEnv } from "../src/env"

describe("normalizeTrailingArguments", () => {
  it("preserves command flags after -- as operands", () => {
    const normalized = normalizeTrailingArguments(["run", "--env", "A=op://v/i/f", "--", "sh", "-c", "echo ok"])
    assert.strictEqual(normalized.length, 6)
    assert.strictEqual(normalized[0], "run")
    assert.strictEqual(normalized[1], "--env")
    assert.strictEqual(normalized[2], "A=op://v/i/f")
    assert.deepStrictEqual(decodeTrailingArguments(normalized.slice(3)), ["sh", "-c", "echo ok"])
  })
})

describe("parseAssignment", () => {
  it("parses a secret reference", () => {
    assert.deepStrictEqual(parseAssignment("OPENAI_API_KEY=op://Personal/OpenAI API Key/credential"), {
      name: "OPENAI_API_KEY",
      reference: "op://Personal/OpenAI API Key/credential",
    })
  })

  it("rejects plaintext", () => {
    assert.throws(() => parseAssignment("OPENAI_API_KEY=plaintext"), /must start with op:\/\//)
  })
})

describe("renderEnv", () => {
  it("writes a deterministic reference file", () => {
    assert.strictEqual(
      renderEnv([{ name: "OPENAI_API_KEY", reference: "op://Personal/OpenAI API Key/credential" }]),
      "OPENAI_API_KEY=op://Personal/OpenAI API Key/credential\n",
    )
  })
})

describe("resolveEnv", () => {
  it.effect("preserves ordinary lines and safely quotes resolved values", () =>
    Effect.gen(function* () {
      const result = yield* resolveEnv(
        ["# Development", "NODE_ENV=development", "OPENAI_API_KEY=op://Personal/OpenAI API Key/credential", ""].join(
          "\n",
        ),
        () => Effect.succeed(["a secret\nwith lines\n"]),
      )

      assert.deepStrictEqual(result, {
        content: ["# Development", "NODE_ENV=development", 'OPENAI_API_KEY="a secret\\nwith lines"', ""].join("\n"),
        count: 1,
      })
    }),
  )

  it.effect("resolves duplicate references once", () =>
    Effect.gen(function* () {
      let calls = 0
      const result = yield* resolveEnv(
        ["FIRST=op://Personal/Shared/credential", "SECOND=op://Personal/Shared/credential"].join("\n"),
        (references) =>
          Effect.sync(() => {
            calls += 1
            assert.deepStrictEqual(references, ["op://Personal/Shared/credential"])
            return ["secret"]
          }),
      )

      assert.strictEqual(calls, 1)
      assert.strictEqual(result.count, 2)
    }),
  )
})
