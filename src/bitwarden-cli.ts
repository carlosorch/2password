import { Console, Effect } from "effect"
import { Argument, Command, Flag } from "effect/cli"
import { readFile, writeFile } from "node:fs/promises"
import { decodeTrailingArguments } from "./arguments.js"
import { backend, execute, parseAssignment, reference } from "./bitwarden.js"
import { Op } from "./op.js"

const api = backend()
const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2))
const task = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof Op.Failure ? error : Op.fail("Bitwarden operation failed (details suppressed)"),
  })
const organizationFlag = Flag.String("organization").pipe(Flag.withDescription("Secrets Manager organization UUID"))
const assignment = (value: string) => parseAssignment(value)
const assignmentError = () => "Expected a safe NAME=bws://UUID assignment"
const assignmentsFlag = Flag.String("env").pipe(Flag.mapTryCatch(assignment, assignmentError), Flag.atLeast(1))
const commandArgument = Argument.String("command").pipe(Argument.atLeast(1))
const setExitCode = (code: number) =>
  Effect.sync(() => {
    process.exitCode = code
  })

const inventory = Command.make("inventory", { organization: organizationFlag }, ({ organization }) =>
  task(() => api.inventory(organization)).pipe(Effect.flatMap(print)),
)
const find = Command.make(
  "find",
  { organization: organizationFlag, queries: Argument.String("query").pipe(Argument.atLeast(1)) },
  ({ organization, queries }) => task(() => api.find(queries, organization)).pipe(Effect.flatMap(print)),
)
const read = Command.make("read", { reference: Argument.String("reference") }, ({ reference: secretReference }) =>
  task(() => api.read(secretReference)).pipe(
    Effect.flatMap((value) =>
      Effect.sync(() => {
        process.stdout.write(value)
      }),
    ),
  ),
).pipe(Command.withDescription("Explicitly reveal one secret to stdout"))
const run = Command.make("run", { env: assignmentsFlag, command: commandArgument }, ({ env, command }) =>
  task(async () => execute(decodeTrailingArguments(command), await api.resolve(env))).pipe(Effect.flatMap(setExitCode)),
).pipe(Command.withDescription("Inject selected secrets into a trusted command"))

const destination = {
  organization: organizationFlag,
  project: Flag.String("project").pipe(Flag.withDescription("Destination project UUID")),
  title: Flag.String("title"),
  notes: Flag.String("notes").pipe(Flag.withDefault("")),
  stdin: Flag.Boolean("stdin").pipe(Flag.withDefault(false)),
  clipboard: Flag.Boolean("clipboard").pipe(Flag.withDefault(false)),
}
const write = (options: {
  organization: string
  project: string
  title: string
  notes: string
  stdin: boolean
  clipboard: boolean
  reference?: string
}) =>
  Effect.gen(function* () {
    if (options.stdin === options.clipboard) return yield* Op.fail("Choose exactly one of --stdin or --clipboard")
    const value = yield* Op.privateInput(options.stdin ? "stdin" : "clipboard", "secret", "nothing written")
    yield* print(
      yield* task(() =>
        api.write({
          organization: options.organization,
          project: options.project,
          key: options.title,
          note: options.notes,
          value,
          ref: options.reference,
        }),
      ),
    )
  })
const create = Command.make("create", destination, write).pipe(
  Command.withDescription("Create and read back a secret from private input, never argv"),
)
const update = Command.make("update", { ...destination, reference: Argument.String("reference") }, write).pipe(
  Command.withDescription("Update and verify an explicitly named secret; never retried"),
)

const envWrite = Command.make(
  "write",
  {
    file: Argument.String("file"),
    assignments: Argument.String("assignment").pipe(
      Argument.mapTryCatch(assignment, assignmentError),
      Argument.atLeast(1),
    ),
  },
  ({ file, assignments }) =>
    task(async () => {
      if (new Set(assignments.map((item) => item.name)).size !== assignments.length)
        throw Op.fail("Supply unique destination names")
      await writeFile(file, assignments.map(({ name, id }) => `${name}=${reference(id)}\n`).join(""), { mode: 0o600 })
      return { file, references: assignments.length }
    }).pipe(Effect.flatMap(print)),
).pipe(Command.withDescription("Write a template containing references only; replaces the destination"))
const envRun = Command.make("run", { file: Argument.String("file"), command: commandArgument }, ({ file, command }) =>
  task(async () => {
    const text = await readFile(file, "utf8")
    const values = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(parseAssignment)
    return execute(decodeTrailingArguments(command), await api.resolve(values))
  }).pipe(Effect.flatMap(setExitCode)),
).pipe(Command.withDescription("Use a strict NAME=bws://UUID template; no plaintext values or shell expansion"))
const env = Command.make("env").pipe(Command.withSubcommands([envWrite, envRun]))
const doctor = Command.make("doctor", {}, () =>
  task(async () => {
    let sdkAvailable = false
    try {
      await import("@bitwarden/sdk-napi")
      sdkAvailable = true
    } catch {
      /* Never expose native loader diagnostics. */
    }
    return {
      provider: "bitwarden-secrets-manager",
      sdkAvailable,
      tokenConfigured: Boolean(process.env.BWS_ACCESS_TOKEN?.trim()),
      tokenStorage: "environment only; no token persisted",
      authenticationAttempted: false,
    }
  }).pipe(Effect.flatMap(print)),
).pipe(Command.withDescription("Check SDK availability without authenticating or revealing the token"))

export const bitwarden = Command.make("bitwarden").pipe(
  Command.withDescription("Bitwarden Secrets Manager, independent of your personal password vault"),
  Command.withSubcommands([doctor, inventory, find, read, run, create, update, env]),
)
