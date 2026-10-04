// Windows test shim, compiled once to an .exe and hard-linked into the sandbox as each fake
// (op.exe, powershell.exe, ...). Node refuses some arguments for .cmd files, so fakes must be
// real executables. `<name>.target.json` next to the link holds the command it forwards to.
import { readFileSync } from "node:fs"

const target = JSON.parse(readFileSync(process.execPath.replace(/\.exe$/i, ".target.json"), "utf8")) as Array<string>
const child = Bun.spawn([...target, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] })
process.exit(await child.exited)
