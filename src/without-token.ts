// Windows replacement for `env -u OP_SERVICE_ACCOUNT_TOKEN <command>`: op run starts this
// helper, which removes the token and runs the command with the terminal attached.
const [command, ...args] = process.argv.slice(2)
if (command === undefined) process.exit(2)
const env = { ...process.env }
delete env.OP_SERVICE_ACCOUNT_TOKEN
const child = Bun.spawn([command, ...args], { env, stdio: ["inherit", "inherit", "inherit"] })
void child.exited.then((code) => process.exit(code))
