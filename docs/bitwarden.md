# Bitwarden Secrets Manager

This fork adds `2password bitwarden` without changing the original 1Password commands. It uses the official `@bitwarden/sdk-napi` SDK. Neither `op`, `bw` nor `bws` is required for these commands.

Secrets Manager is separate from your personal Bitwarden password vault. It supports project-scoped machine accounts, making it preferable to unlocking an entire personal vault for an agent. The free plan currently permits two users, three projects and three machine accounts, with unlimited secrets. See [official plans](https://bitwarden.com/help/secrets-manager-plans/).

## Setup

1. Enable Secrets Manager in a Bitwarden organization and create an automation project.
2. Add a machine account with access to only that project. Prefer read-only access for consumption; grant write access only when needed.
3. Generate its access token. Supply `BWS_ACCESS_TOKEN` through a masked secret-input tool or a trusted launcher. Do not put it into chat, shell history, command arguments, or repository files.
4. Use `bitwarden doctor` to check native SDK availability and whether the token is configured. Doctor does not authenticate. `inventory` is the first authenticated operation.

Use the organization and project UUIDs from Bitwarden. No organization, project or account is provisioned automatically. No token is saved on disk and no SDK state/cache file is requested. A secure desktop token-store integration is not implemented.

The SDK's native binaries cover Linux x64 glibc, macOS x64/arm64 and Windows x64. Linux arm64 and musl are not supported by this pinned SDK package. The default endpoints are Bitwarden's US cloud. EU cloud and self-hosted endpoints are not implemented.

## Commands

Examples use the source checkout. If a trusted launcher exposes the `2password` executable, the same subcommands apply.

```sh
bun run bin/2password bitwarden doctor
bun run bin/2password bitwarden inventory --organization <organization-uuid>
bun run bin/2password bitwarden find openai stripe --organization <organization-uuid>
bun run bin/2password bitwarden run --env "OPENAI_API_KEY=bws://<secret-uuid>" -- pnpm run dev
bun run bin/2password bitwarden env write .env.tpl "OPENAI_API_KEY=bws://<secret-uuid>"
bun run bin/2password bitwarden env run .env.tpl -- pnpm run dev
```

`find` returns secret names, IDs, organization IDs and stable `bws://UUID` references. It does not print values or notes. Names are non-secret metadata; never put a credential into a name or note.

Templates contain only `NAME=bws://UUID` assignments, blank lines and comments. Plaintext values, quoting, shell expansion and duplicate destination names are rejected. Authentication and process-control destination names are rejected. There is no Bitwarden `env resolve` command, so reference templates never become plaintext files.

### Create and update

On Linux, pipe private input directly from a trusted producer. Do not retrieve the input into the agent transcript first. Input bytes, including trailing newlines, are preserved.

```sh
trusted-secret-producer | bun run bin/2password bitwarden create --organization <organization-uuid> --project <project-uuid> --title OPENAI_API_KEY --stdin
trusted-secret-producer | bun run bin/2password bitwarden update bws://<secret-uuid> --organization <organization-uuid> --project <project-uuid> --title OPENAI_API_KEY --stdin
```

`--clipboard` is available on macOS and Windows; Linux uses `--stdin`. Exactly one source is required. `--notes` accepts non-secret metadata.

Creation refuses a matching name among the secrets visible to the machine account in that organization. This is a pre-write check, not an atomic uniqueness guarantee: parallel clients or inaccessible secrets may still have the same name. Use one writer per project. Update requires an explicit secret reference and checks its organization and project before writing. Update replaces the name, value and notes; omitted notes become empty.

Every write runs once and is then read back. Success returns a metadata receipt with `verified: true`, never the value. An uncertain result says the write may have succeeded and must not be retried automatically. Inspect `inventory` first, or have a human verify in Bitwarden.

### Explicit disclosure

`bitwarden read bws://<secret-uuid>` deliberately prints a value. It is a last resort, not an agent discovery command. Do not run it just to check that injection or a write worked.

## Security boundary

Tokens and write values enter the SDK worker through a private stdin pipe, not arguments. Its stdout is captured internally and its stderr is discarded. All SDK failures become fixed messages; raw SDK diagnostics never reach the conversation. Reads are batched before starting the target command, and missing, duplicate or unexpected IDs fail closed.

`run` and `env run` remove all `BWS_*`, `BW_*` and `OP_*` variables from the target environment, including the machine token and personal-vault sessions. The target receives only the selected secret values plus the remaining inherited environment. It runs directly without an implicit shell. Its exit code is propagated.

The selected program can print, save or transmit those values. This tool is not a sandbox, and an agent with unrestricted shell access under the same user can obtain credentials from its environment or other processes. Project-scoped account permissions, trusted commands and OS isolation remain necessary.

## Verification

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm audit --prod
```

Tests use fictional credentials and fake transports. The CLI tests exercise doctor, reference templates, private-input validation and fail-closed behavior without authenticating. They do not prove successful access to a real Bitwarden account. Live verification must use a disposable project and credential, never a production secret.
