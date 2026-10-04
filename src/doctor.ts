import { Effect, Option, Schema } from "effect"
import { ChildProcess } from "effect/process"
import { Auth } from "./auth.js"
import { Op } from "./op.js"

const INSTALL_OP = "Install the 1Password CLI: https://developer.1password.com/docs/cli/get-started/"
const ENABLE_INTEGRATION =
  "No 1Password accounts are visible. In the 1Password app, turn on Settings > Developer > Integrate with 1Password CLI."
const PER_SHELL =
  "Desktop approvals last per terminal session. Agents without a terminal may be asked again in every new shell: batch lookups into one command, or run `2password service-account setup` for no prompts."

// Only what is safe to paste into a public issue: versions and counts, never
// account names, emails, vaults, or items.
const local = (args: ReadonlyArray<string>) =>
  Op.capture(ChildProcess.make(Op.program("op"), args, { stdin: "ignore", stderr: "ignore" }), "op unavailable").pipe(
    Effect.timeout("5 seconds"),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  )

// Never authenticates: no item or vault access, no Keychain read, so it can never prompt.
export const doctor = (version: string) =>
  Effect.gen(function* () {
    const opVersion = (yield* local(["--version"]))?.trim()
    const accounts =
      opVersion === undefined
        ? undefined
        : yield* local(["account", "list", "--format", "json"]).pipe(
            Effect.flatMap((text) =>
              Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.Unknown)))(text ?? "[]"),
            ),
            Effect.map((list) => list.length),
            Effect.orElseSucceed(() => 0),
          )
    const auth = process.env.OP_SERVICE_ACCOUNT_TOKEN
      ? "environment service account"
      : yield* Auth.settings.pipe(
          Effect.map((saved) => (saved ? "saved service account" : "desktop app")),
          Effect.orElseSucceed(() => "saved service account (settings unreadable; use --desktop)"),
        )
    const notes = [
      ...(opVersion === undefined ? [INSTALL_OP] : []),
      ...(auth === "desktop app" && accounts === 0 ? [ENABLE_INTEGRATION] : []),
      ...(auth === "desktop app" && opVersion !== undefined ? [PER_SHELL] : []),
    ]
    return {
      "2password": version,
      platform: `${process.platform}-${process.arch}`,
      bun: Bun.version,
      op: opVersion ?? null,
      accounts: accounts ?? null,
      auth,
      ...(notes.length === 0 ? {} : { notes }),
    }
  })

export * as Doctor from "./doctor.js"
