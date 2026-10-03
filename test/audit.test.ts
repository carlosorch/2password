import { assert, describe, it } from "@effect/vitest"
import { sandbox } from "./sandbox.js"

const op = `#!/bin/sh
if [ "$1 $2" = "item list" ]; then
  printf '%s' '[{"id":"1","title":"Cloud Key","category":"API_CREDENTIAL","vault":{"name":"Personal"}},{"id":"2","title":"Example","category":"LOGIN","vault":{"name":"Personal"}},{"id":"3","title":"Example","category":"LOGIN","vault":{"name":"Personal"}}]'
else
  cat > /dev/null
  printf '%s\\n%s\\n%s' '{"id":"1","title":"Cloud Key","category":"API_CREDENTIAL","vault":{"name":"Personal"},"fields":[]}' '{"id":"2","title":"Example","category":"LOGIN","vault":{"name":"Personal"},"updated_at":"2010-01-01T00:00:00Z","urls":[{"href":"https://example.com/oauth/callback?code=secret"}],"fields":[]}' '{"id":"3","title":"Example","category":"LOGIN","vault":{"name":"Personal"},"updated_at":"2026-01-01T00:00:00Z","fields":[]}'
fi
`

describe("audit", () => {
  it("reports organization findings from safe metadata", async () => {
    const box = await sandbox({ op })
    try {
      const { stdout, stderr } = await box.run(["audit", "--vault", "Personal"])
      assert.strictEqual(stderr, "")
      const output = JSON.parse(stdout)
      assert.deepStrictEqual(output.summary, { items: 3, tagged: 0, untagged: 3 })
      assert.deepStrictEqual(output.duplicateTitles, [
        {
          title: "Example",
          items: [
            { id: "2", title: "Example" },
            { id: "3", title: "Example" },
          ],
        },
      ])
      assert.deepStrictEqual(output.untaggedMachineCredentials, [
        { id: "1", title: "Cloud Key", kind: "api-credential" },
      ])
      assert.strictEqual(output.oldLogins[0].id, "2")
      assert.deepStrictEqual(output.urlsToReview, [
        { id: "2", title: "Example", urls: ["https://example.com/oauth/callback"] },
      ])
      assert.notInclude(stdout, "code=secret")
    } finally {
      await box.close()
    }
  })
})
