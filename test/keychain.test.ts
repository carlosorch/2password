import { assert, it } from "@effect/vitest"
import { execFile } from "node:child_process"
import { join } from "node:path"

// Explicit opt-in: creates only a unique fictional item in the current user's
// Keychain (macOS) or DPAPI store (Windows), and verifies its removal.
// Ordinary tests use isolated process fakes.
const helper = (operation: string, service: string): [string, Array<string>] =>
  process.platform === "win32"
    ? [
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(import.meta.dirname, "../src/credential.win.ps1"),
          operation,
          service,
          "test",
        ],
      ]
    : [
        "/usr/bin/osascript",
        ["-l", "JavaScript", join(import.meta.dirname, "../src/keychain.jxa.js"), operation, service, "test"],
      ]

it.runIf(
  (process.platform === "darwin" || process.platform === "win32") && process.env.TWO_PASSWORD_KEYCHAIN_TEST === "1",
)("stores long tokens natively without argv secrets or duplicate replacement", async () => {
  const service = `2password-test-${crypto.randomUUID()}`
  const token = `ops_${"fictional".repeat(1024)}`
  const call = (operation: string, input = "") =>
    new Promise<{ code: string | number | null; stdout: string }>((resolve, reject) => {
      const child = execFile(...helper(operation, service), { timeout: 10_000 }, (error, stdout) => {
        if (error?.killed) reject(new Error("Native Keychain helper timed out"))
        else resolve({ code: error?.code ?? 0, stdout })
      })
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
    })
  try {
    assert.strictEqual((await call("exists")).stdout.trim(), "missing")
    assert.strictEqual((await call("add", token)).code, 0)
    assert.strictEqual((await call("exists")).stdout.trim(), "found")
    assert.isTrue((await call("get")).stdout.replace(/\r?\n$/, "") === token)
    assert.notStrictEqual((await call("add", "fictional-replacement")).code, 0)
    assert.isTrue((await call("get")).stdout.replace(/\r?\n$/, "") === token)
  } finally {
    assert.strictEqual((await call("remove")).code, 0)
    assert.strictEqual((await call("exists")).stdout.trim(), "missing")
  }
})
