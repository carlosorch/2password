import { assert, describe, it } from "@effect/vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { sandbox } from "./sandbox.js"

const op = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/op.log"
if [ "$1 $2" = "item list" ]; then
  printf '%s' '[{"id":"1","title":"Cloud API Key","category":"API_CREDENTIAL","vault":{"id":"v1","name":"Work"},"version":2}]'
else
  cat > /dev/null
  printf '%s' '{"id":"1","title":"Cloud API Key","category":"API_CREDENTIAL","vault":{"name":"Work"},"tags":["production","cloud"],"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-02-01T00:00:00Z","urls":[{"href":"https://cloud.example.com/login?token=secret#fragment"}],"fields":[{"id":"credential","label":"credential","type":"CONCEALED","reference":"op://Work/Cloud API Key/credential","value":"must-not-leak"},{"id":"owner","label":"owner","type":"STRING","value":"private@example.com"}]}'
fi
`

describe("inventory", () => {
  it("returns metadata without field values or URL parameters", async () => {
    const box = await sandbox({ op })
    try {
      const { stdout, stderr } = await box.run(["inventory", "--vault", "Work"])
      assert.strictEqual(stderr, "")
      assert.deepStrictEqual((await readFile(join(box.home, "op.log"), "utf8")).trim().split("\n"), [
        "item list --format json --vault Work",
        "item get - --format json",
      ])
      assert.deepStrictEqual(JSON.parse(stdout).items, [
        {
          id: "1",
          title: "Cloud API Key",
          vault: "Work",
          kind: "api-credential",
          tags: ["cloud", "production"],
          urls: ["https://cloud.example.com/login"],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-02-01T00:00:00Z",
          fields: [
            { label: "credential", type: "concealed", ref: "op://Work/Cloud API Key/credential" },
            { label: "owner", type: "string" },
          ],
        },
      ])
      for (const secret of ["must-not-leak", "private@example.com", "token=secret"]) assert.notInclude(stdout, secret)
    } finally {
      await box.close()
    }
  })
})
