# 2password

Fork of [kitlangton/2password](https://github.com/kitlangton/2password) with Bitwarden Secrets Manager support. The original 1Password commands remain available.

Bitwarden commands use the official SDK, not the personal-vault `bw` CLI. No 1Password installation is needed for Bitwarden. See [the Bitwarden guide](docs/bitwarden.md) for setup and security limits.

## Install

Requires [Bun](https://bun.sh), Node.js 24 and pnpm 11.10.0. The [1Password CLI](https://developer.1password.com/docs/cli/get-started/) is only needed for the original commands.

```sh
git clone https://github.com/carlosorch/2password.git
cd 2password
pnpm install --frozen-lockfile --ignore-scripts
bun run bin/2password bitwarden doctor
```

Run the CLI from this checkout with `bun run bin/2password`. This fork is not published to npm and has no automatic publishing workflow.

## Bitwarden Secrets Manager

```sh
bun run bin/2password bitwarden find openai --organization <organization-uuid>
bun run bin/2password bitwarden run --env "OPENAI_API_KEY=bws://<secret-uuid>" -- pnpm run dev
bun run bin/2password bitwarden env run .env.tpl -- pnpm run dev
```

Configure a scoped machine-account token through a masked secret-input tool or your existing secret launcher. Never paste it into an agent conversation. The CLI reads `BWS_ACCESS_TOKEN`; it does not persist the token.

## Use

```sh
2password find openai stripe        # returns op:// references, never values
2password run --env "OPENAI_API_KEY=op://Personal/OpenAI API Key/credential" -- bun dev
2password env run .env.tpl -- bun dev
2password create api-credential --title "OpenAI API Key" --vault Personal --clipboard
```

Run `2password --help` to see all commands.

## Fewer prompts

- **One prompt per command.** `find` with many queries and env files with many references each need a single 1Password approval.
- **No prompts at all.** Give your agent its own vault and a service account whose token lives in macOS Keychain, or on Windows in a file encrypted for your user (DPAPI):

  ```sh
  2password service-account setup --vault Automation --create-vault --write --save-vault Personal
  ```

## Safety

- Only `read` and `env resolve` intentionally return or materialize a secret from 2password.
- `run` and `env run` inject plaintext into the selected child process. 2password does not print the value, but the child can; only use them with commands you trust with that credential.
- New secrets come in through the clipboard or a pipe, never as arguments. Every write is read back and checked.
- Writes are never retried automatically.

MIT
