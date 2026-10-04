import { assert, describe, it } from "@effect/vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { sandbox } from "./sandbox.js"

const op = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/op.log"
case "$1" in
  --version) printf '2.40.0\\n' ;;
  account) printf '%s' '[{"url":"example.1password.com","email":"private@example.com","user_uuid":"U","account_uuid":"A"}]' ;;
  *) exit 71 ;;
esac
`

describe("doctor", () => {
  it("reports versions and counts without authenticating or revealing the account", async () => {
    const box = await sandbox({ op })
    try {
      const { code, stdout } = await box.run(["doctor"])
      assert.strictEqual(code, 0)
      const report = JSON.parse(stdout)
      assert.strictEqual(report.op, "2.40.0")
      assert.strictEqual(report.accounts, 1)
      assert.strictEqual(report.auth, "desktop app")
      assert.deepStrictEqual((await readFile(join(box.home, "op.log"), "utf8")).trim().split("\n"), [
        "--version",
        "account list --format json",
      ])
      for (const text of ["private@example.com", "example.1password.com"]) assert.notInclude(stdout, text)
    } finally {
      await box.close()
    }
  })

  it("explains how to install op when it is missing", async () => {
    const box = await sandbox({})
    try {
      const { code, stdout } = await box.run(["doctor"])
      assert.strictEqual(code, 0)
      const report = JSON.parse(stdout)
      assert.strictEqual(report.op, null)
      assert.match(report.notes[0], /Install the 1Password CLI/)
    } finally {
      await box.close()
    }
  })
})
