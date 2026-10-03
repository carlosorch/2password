import { assert, describe, it } from "@effect/vitest"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { sandbox } from "./sandbox.js"

const op = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/op.log"
if [ "$1 $2" = "item list" ]; then
  printf '%s' '[{"id":"1","title":"Cloud API","category":"API_CREDENTIAL","vault":{"id":"v1","name":"Personal"},"version":2},{"id":"2","title":"Cloud Login","category":"LOGIN","vault":{"id":"v2","name":"Work"},"version":3},{"id":"3","title":"Database","category":"DATABASE","vault":{"id":"v2","name":"Work"},"version":4}]'
else
  cat > "$HOME/input"
  printf '%s\\n%s\\n%s' '{"id":"1","title":"Cloud API","category":"API_CREDENTIAL","vault":{"name":"Personal"},"fields":[{"id":"credential","label":"credential","type":"CONCEALED","reference":"op://Personal/Cloud API/credential"}]}' '{"id":"2","title":"Cloud Login","category":"LOGIN","vault":{"name":"Work"},"fields":[{"id":"password","label":"password","type":"CONCEALED","purpose":"PASSWORD","reference":"op://Work/Cloud Login/password"}]}' '{"id":"3","title":"Database","category":"DATABASE","vault":{"name":"Work"},"fields":[{"id":"password","label":"password","type":"CONCEALED","purpose":"PASSWORD","reference":"op://Work/Database/password"}]}'
fi
`

describe("find", () => {
  it("gets the union of multiple queries in one item-details invocation", async () => {
    const box = await sandbox({ op })
    try {
      const { stdout, stderr } = await box.run(["find", "database", "cloud api", "cloud"])
      assert.strictEqual(stderr, "")
      assert.deepStrictEqual((await readFile(join(box.home, "op.log"), "utf8")).trim().split("\n"), [
        "item list --format json",
        "item get - --format json",
      ])
      // Listing entries are forwarded verbatim, in listing order.
      assert.deepStrictEqual(
        JSON.parse(await readFile(join(box.home, "input"), "utf8")).map((item: { id: string; version: number }) => [
          item.id,
          item.version,
        ]),
        [
          ["1", 2],
          ["2", 3],
          ["3", 4],
        ],
      )
      const output = JSON.parse(stdout)
      assert.deepStrictEqual(
        output.matches.map((match: { ref: string }) => match.ref),
        ["op://Personal/Cloud API/credential", "op://Work/Cloud Login/password", "op://Work/Database/password"],
      )
      assert.deepStrictEqual(
        output.results.map((result: { query: string; matches: ReadonlyArray<unknown> }) => [
          result.query,
          result.matches.length,
        ]),
        [
          ["database", 1],
          ["cloud api", 1],
          ["cloud", 2],
        ],
      )
    } finally {
      await box.close()
    }
  })
})
