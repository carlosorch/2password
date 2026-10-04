import { execFile, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs"
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const windows = process.platform === "win32"
const gitSh = process.env.TWO_PASSWORD_TEST_SH ?? "C:\\Program Files\\Git\\usr\\bin\\sh.exe"

export const bun = execFileSync("bun", ["-p", "process.execPath"], { encoding: "utf8" }).trim()
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

// Windows only: compile test/shim.ts once per Bun version and shim source, shared by all workers.
const shim = (() => {
  if (!windows) return ""
  const source = join(import.meta.dirname, "shim.ts")
  const version = execFileSync(bun, ["--version"], { encoding: "utf8" }).trim()
  const hash = createHash("sha256").update(version).update(readFileSync(source)).digest("hex").slice(0, 12)
  const file = join(tmpdir(), `2password-test-shim-${hash}.exe`)
  if (existsSync(file)) return file
  const building = `${file}.${process.pid}.tmp.exe`
  execFileSync(bun, ["build", "--compile", source, "--outfile", building], { stdio: "ignore" })
  try {
    renameSync(building, file)
  } catch {
    rmSync(building, { force: true }) // another worker finished first
  }
  return file
})()

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
const windowsFake = async (home: string, command: string, script: string) => {
  await link(shim, join(home, `${command}.exe`))
  await writeFile(join(home, `${command}.target.json`), JSON.stringify([gitSh, script]))
}

export const sandbox = async (fakes: Record<string, string | ((command: string) => string)>): Promise<Sandbox> => {
  const home = await mkdtemp(join(tmpdir(), "2password-test-"))
  const callsFile = join(home, "calls")
  for (const [command, source] of Object.entries(fakes)) {
    const file = join(home, command)
    await writeFile(file, typeof source === "string" ? source : source(command))
    await chmod(file, 0o755)
    // Windows can't execute shebang scripts: an .exe shim runs each fake with Git's sh.
    if (windows) await windowsFake(home, command, file)
  }
  // On Windows the CLI reaches the clipboard and credential store through powershell;
  // fixtures map that name back onto pbpaste and osascript (fixtures/platform.ts).
  const stand = fakes.pbpaste ?? fakes.osascript
  if (windows && stand !== undefined && fakes.powershell === undefined) {
    const file = join(home, "powershell")
    await writeFile(file, typeof stand === "string" ? stand : stand("powershell"))
    await windowsFake(home, "powershell", file)
  }
  if (!windows) for (const command of ["sh", "cat"]) await symlink(`/bin/${command}`, join(home, command))

  const run: Sandbox["run"] = async (args, { input = "", env = {} } = {}) => {
    await writeFile(callsFile, "")
    return new Promise((resolve, reject) => {
      const child = execFile(
        bun,
        ["run", "bin/2password", ...args],
        {
          cwd: join(import.meta.dirname, ".."),
          // On Windows PATH also holds Git's usr/bin (sh, cat, printf for the fakes; no op,
          // pbpaste or powershell), and SystemRoot is needed for processes to start.
          env: {
            HOME: home,
            PATH: windows ? `${home};${dirname(gitSh)}` : home,
            TEST_CALLS: callsFile,
            ...(windows ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
            ...env,
          },
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
