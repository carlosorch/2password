// On Windows the CLI reaches the clipboard and the credential store through powershell.
// Fixtures map those calls onto the macOS command names, so recorded calls and assertions
// are the same on every platform.
export const normalize = ([command, ...args]: Array<string>): Array<string> => {
  if (command !== "powershell") return [command ?? "", ...args]
  const file = args.indexOf("-File")
  return file === -1 ? ["pbpaste"] : ["osascript", "-l", "JavaScript", ...args.slice(file + 1)]
}
