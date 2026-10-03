import { execFile, execFileSync } from "node:child_process"
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const bun = execFileSync("bun", ["-p", "process.execPath"], { encoding: "utf8" }).trim()
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export interface Result {
  readonly code: number | string
  readonly stdout: string
  readonly stderr: string
}

export interface Sandbox {
  // Temporary HOME, also the only PATH entry.
  readonly home: string
  readonly run: (
    args: ReadonlyArray<string>,
    options?: { readonly input?: string; readonly env?: Record<string, string> },
  ) => Promise<Result>
  // JSON lines that fixtures appended to $TEST_CALLS, cleared on every run.
  readonly calls: <A = { command: string; args: Array<string> }>() => Promise<Array<A>>
  readonly close: () => Promise<void>
}

// A fake executable that runs a TypeScript fixture as `<fixture> <command> ...args`.
export const fixture = (path: string) => (command: string) =>
  `#!/bin/sh\nexec ${quote(bun)} ${quote(path)} ${command} "$@"\n`

// Runs the real CLI against fake executables. PATH contains only `sh`, `cat`, and
// the fakes, so no test can ever reach the real op, clipboard, or Keychain.
export const sandbox = async (fakes: Record<string, string | ((command: string) => string)>): Promise<Sandbox> => {
  const home = await mkdtemp(join(tmpdir(), "2password-test-"))
  const callsFile = join(home, "calls")
  for (const [command, source] of Object.entries(fakes)) {
    const file = join(home, command)
    await writeFile(file, typeof source === "string" ? source : source(command))
    await chmod(file, 0o755)
  }
  for (const command of ["sh", "cat"]) await symlink(`/bin/${command}`, join(home, command))

  const run: Sandbox["run"] = async (args, { input = "", env = {} } = {}) => {
    await writeFile(callsFile, "")
    return new Promise((resolve, reject) => {
      const child = execFile(
        bun,
        ["run", "bin/2password", ...args],
        {
          cwd: join(import.meta.dirname, ".."),
          env: { HOME: home, PATH: home, TEST_CALLS: callsFile, ...env },
          timeout: 15_000,
        },
        (error, stdout, stderr) =>
          error?.killed
            ? reject(new Error(`2password ${args.join(" ")} timed out`))
            : resolve({ code: error?.code ?? 0, stdout, stderr }),
      )
      child.stdin?.on("error", () => {}) // the CLI may exit before reading input
      child.stdin?.end(input)
    })
  }
  const calls = async <A>() =>
    (await readFile(callsFile, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as A)

  return { home, run, calls, close: () => rm(home, { recursive: true, force: true }) }
}
