import { Context, Effect, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class Failure extends Schema.TaggedError<Failure>()("Failure", { message: Schema.String }) {}

export const fail = (message: string) => new Failure({ message })

export const Id = Schema.String.check(Schema.isPattern(/^[a-z0-9]{26}$/))

export type Environment = Record<string, string | undefined>

// The authentication environment every op invocation runs with. Auth.make selects it.
export class Credentials extends Context.Service<
  Credentials,
  {
    readonly environment: Effect.Effect<Environment, Failure>
  }
>()("2password/Credentials") {}

export const withCredentials = (environment: Environment) =>
  Effect.provideService(Credentials, { environment: Effect.succeed(environment) })

const output = Effect.fn("output")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(command)
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(handle.stdout)),
      Stream.mkString(Stream.decodeText(handle.stderr)),
      handle.exitCode,
    ],
    { concurrency: "unbounded" },
  )
  return { stdout, stderr, exitCode: Number(exitCode) }
}, Effect.scoped)

// Runs a local helper. Every failure becomes `message`; its diagnostics never escape.
export const capture = (command: ChildProcess.Command, message: string) =>
  output(command).pipe(
    Effect.filterOrFail(({ exitCode }) => exitCode === 0),
    Effect.mapBoth({ onFailure: () => fail(message), onSuccess: ({ stdout }) => stdout }),
  )

export type Source = "clipboard" | "stdin"

// Reads a secret from the clipboard or a pipe without displaying, echoing, or clearing it.
export const privateInput = Effect.fn("privateInput")(function* (source: Source, noun: string, outcome: string) {
  if (source === "clipboard" && process.platform !== "darwin") {
    return yield* fail(`--clipboard requires macOS; use --stdin on other platforms; ${outcome}`)
  }
  if (source === "stdin" && process.stdin.isTTY) {
    return yield* fail(`Pipe the ${noun} to --stdin; interactive input is not supported; ${outcome}`)
  }
  const input = yield* capture(
    source === "clipboard"
      ? ChildProcess.make("pbpaste", [], { stdin: "ignore", stderr: "ignore" })
      : ChildProcess.make("cat", [], { stdin: "inherit", stderr: "ignore" }),
    `Could not read the ${noun} (details suppressed); ${outcome}`,
  )
  if (!input.trim()) return yield* fail(`The ${noun} input is empty; ${outcome}`)
  return input
})

export interface Options {
  // Fixed message for any failure. Set it whenever plaintext crosses op, so none
  // of op's output can reach an error. Without it, op's stderr is reported.
  readonly failure?: string
  readonly account?: string | undefined
  // Piped to op's stdin, keeping it out of argv, the environment, and temp files.
  readonly input?: string
  readonly env?: Environment
}

export const op = Effect.fn("op")(
  function* (args: ReadonlyArray<string>, options: Options = {}) {
    const authentication = yield* (yield* Credentials).environment
    const env = { ...authentication, ...options.env }
    const argv = options.account ? [...args, "--account", options.account] : args
    const stderr = options.failure === undefined ? "pipe" : "ignore"
    const result = yield* output(
      options.input === undefined
        ? ChildProcess.make("op", argv, { env, extendEnv: true, stdin: "ignore", stderr })
        : // op accepts piped input only from a real pipe. Arguments stay positional, outside shell syntax.
          ChildProcess.make("sh", ["-c", 'cat | exec op "$@"', "2password-op", ...argv], {
            env,
            extendEnv: true,
            stdin: Stream.make(new TextEncoder().encode(options.input)),
            stderr,
          }),
    )
    if (result.exitCode === 0) return result.stdout
    return yield* new Failure({
      message:
        options.failure ??
        (authentication.OP_SERVICE_ACCOUNT_TOKEN
          ? `1Password operation failed with service-account authentication (exit ${result.exitCode}; details suppressed)`
          : result.stderr.trim() || `op exited with ${result.exitCode}`),
    })
  },
  (effect, _args, options) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof Failure ? error : fail(options?.failure ?? "Failed to run 1Password"),
      ),
    ),
)

export const json = <S extends Schema.Constraint>(schema: S, args: ReadonlyArray<string>, options: Options = {}) =>
  op(args, options).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
    Effect.mapError((error) =>
      error instanceof Failure ? error : fail(options.failure ?? "1Password returned invalid JSON"),
    ),
  )

// Runs `op <args> -- command` attached to this terminal and returns the child's exit code.
// Secrets resolve inside op; the service-account token is removed from the child's environment.
export const exec = Effect.fn("exec")(
  function* (args: ReadonlyArray<string>, command: ReadonlyArray<string>, env?: Environment) {
    const authentication = yield* (yield* Credentials).environment
    const child = authentication.OP_SERVICE_ACCOUNT_TOKEN
      ? ["env", "-u", "OP_SERVICE_ACCOUNT_TOKEN", ...command]
      : command
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return Number(
      yield* spawner.exitCode(
        ChildProcess.make("op", [...args, "--", ...child], {
          env: { ...authentication, ...env },
          extendEnv: true,
          stdin: "inherit",
          stdout: "inherit",
          stderr: "inherit",
        }),
      ),
    )
  },
  Effect.mapError((error) => (error instanceof Failure ? error : fail("Failed to run 1Password"))),
)

export * as Op from "./op.js"
