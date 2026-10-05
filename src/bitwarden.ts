import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Op } from "./op.js"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const reference = (id: string) => `bws://${id}`
export function secretId(ref: string): string {
  const id = ref.startsWith("bws://") ? ref.slice(6) : ""
  if (!uuid.test(id)) throw Op.fail("Expected bws:// followed by a secret UUID")
  return id.toLowerCase()
}
export function validId(id: string): string {
  if (!uuid.test(id)) throw Op.fail("Expected a Bitwarden UUID")
  return id.toLowerCase()
}
export function parseAssignment(input: string): { name: string; id: string } {
  const equal = input.indexOf("=")
  const name = input.slice(0, equal)
  if (equal < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw Op.fail("Expected NAME=bws://UUID")
  if (
    /^(BWS_|BW_|OP_|LD_|DYLD_)/i.test(name) ||
    /^(PATH|NODE_OPTIONS|BUN_OPTIONS|BASH_ENV|ENV|SHELLOPTS|PYTHONPATH|PYTHONHOME)$/i.test(name)
  ) {
    throw Op.fail("Authentication and process-control variables cannot be secret destinations")
  }
  return { name, id: secretId(input.slice(equal + 1)) }
}

type Request = Record<string, unknown> & { operation: string }
export type Transport = (request: Request) => Promise<unknown>
interface Secret {
  id: string
  key: string
  organizationId: string
  value: string
  projectId?: string | null
  note?: string
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Op.fail("Invalid Bitwarden response (details suppressed)")
  return value as Record<string, unknown>
}
function metadata(value: unknown) {
  const item = object(value)
  if (
    typeof item.id !== "string" ||
    !uuid.test(item.id) ||
    typeof item.key !== "string" ||
    typeof item.organizationId !== "string"
  ) {
    throw Op.fail("Invalid Bitwarden response (details suppressed)")
  }
  return { id: item.id, key: item.key, organizationId: item.organizationId, reference: reference(item.id) }
}
function secret(value: unknown): Secret {
  const item = object(value)
  const safe = metadata(item)
  if (typeof item.value !== "string") throw Op.fail("Invalid Bitwarden response (details suppressed)")
  return {
    ...safe,
    value: item.value,
    projectId: typeof item.projectId === "string" ? item.projectId : null,
    note: typeof item.note === "string" ? item.note : "",
  }
}

// Never forward SDK stdout or stderr on failure, even if native code logs sensitive data.
export const transport: Transport = (request) =>
  new Promise((resolve, reject) => {
    const token = process.env.BWS_ACCESS_TOKEN
    if (!token?.trim()) return reject(Op.fail("Configure BWS_ACCESS_TOKEN with a scoped machine-account token"))
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(BWS_|BW_|OP_)/i.test(key)) delete env[key]
    const child = spawn(process.execPath, [fileURLToPath(new URL("./bitwarden-worker.ts", import.meta.url))], {
      env,
      stdio: ["pipe", "pipe", "ignore"],
    })
    let output = ""
    const fail = () =>
      reject(Op.fail("Bitwarden operation failed (details suppressed); check the token and permissions"))
    const timer = setTimeout(() => {
      child.kill()
      fail()
    }, 30_000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
      if (output.length > 8 * 1024 * 1024) {
        child.kill()
        fail()
      }
    })
    child.stdin.on("error", fail)
    child.on("error", () => {
      clearTimeout(timer)
      fail()
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) return fail()
      try {
        resolve(JSON.parse(output))
      } catch {
        fail()
      }
    })
    child.stdin.end(JSON.stringify({ ...request, token }))
  })

export function backend(send: Transport = transport) {
  // Also sanitize injected/test transports: never expose a thrown SDK error.
  const call = async (request: Request) => {
    try {
      return await send(request)
    } catch {
      throw Op.fail("Bitwarden operation failed (details suppressed); check the token and permissions")
    }
  }
  const get = async (ref: string) => {
    const id = secretId(ref)
    const result = secret(await call({ operation: "get", id }))
    if (result.id.toLowerCase() !== id) throw Op.fail("Bitwarden returned a different secret; nothing executed")
    return result
  }
  const inventory = async (organization: string) => {
    const result = object(await call({ operation: "list", organization: validId(organization) }))
    if (!Array.isArray(result.data)) throw Op.fail("Invalid Bitwarden response (details suppressed)")
    const items = result.data.map(metadata)
    if (items.some((item) => item.organizationId.toLowerCase() !== organization.toLowerCase()))
      throw Op.fail("Bitwarden returned a different organization")
    return { items }
  }
  return {
    inventory,
    async find(queries: readonly string[], organization: string) {
      const { items } = await inventory(organization)
      return {
        matches: queries.map((query) => ({
          query,
          items: items.filter((item) => item.key.toLowerCase().includes(query.toLowerCase())),
        })),
      }
    },
    async read(ref: string) {
      return (await get(ref)).value
    },
    async resolve(assignments: readonly { name: string; id: string }[]) {
      if (!assignments.length || new Set(assignments.map((item) => item.name)).size !== assignments.length)
        throw Op.fail("Supply unique secret destination names")
      for (const item of assignments) parseAssignment(`${item.name}=${reference(item.id)}`)
      const ids = [...new Set(assignments.map((item) => item.id))]
      const response = object(await call({ operation: "getByIds", ids }))
      if (!Array.isArray(response.data)) throw Op.fail("Invalid Bitwarden response (details suppressed)")
      const values = new Map<string, string>()
      for (const data of response.data) {
        const item = secret(data)
        if (!ids.includes(item.id) || values.has(item.id))
          throw Op.fail("Unexpected Bitwarden secret response; nothing executed")
        values.set(item.id, item.value)
      }
      if (values.size !== ids.length) throw Op.fail("Some Bitwarden secrets are unavailable; nothing executed")
      return Object.fromEntries(assignments.map(({ name, id }) => [name, values.get(id)!]))
    },
    async write(options: {
      organization: string
      project: string
      key: string
      note: string
      value: string
      ref?: string
    }) {
      const organization = validId(options.organization)
      const project = validId(options.project)
      if (!options.key.trim() || !options.value.length)
        throw Op.fail("Secret name and private input must not be empty; nothing written")
      const id = options.ref === undefined ? undefined : secretId(options.ref)
      // Updates explicitly name the destination and require it to match before any write.
      if (id) {
        const existing = await get(reference(id))
        if (existing.organizationId.toLowerCase() !== organization || existing.projectId?.toLowerCase() !== project)
          throw Op.fail("The update destination does not match the secret; nothing written")
      } else {
        const { items } = await inventory(organization)
        if (items.some((item) => item.key.toLowerCase() === options.key.toLowerCase()))
          throw Op.fail("A secret with this name already exists; nothing written")
      }
      try {
        const written = secret(
          await call({
            operation: id ? "update" : "create",
            id,
            organization,
            project,
            key: options.key,
            note: options.note,
            value: options.value,
          }),
        )
        if (id && written.id.toLowerCase() !== id) throw new Error()
        const checked = await get(reference(written.id))
        if (
          checked.value !== options.value ||
          checked.key !== options.key ||
          checked.note !== options.note ||
          checked.organizationId.toLowerCase() !== organization ||
          checked.projectId?.toLowerCase() !== project
        )
          throw new Error()
        return { ...metadata(checked), verified: true }
      } catch {
        throw Op.fail("Bitwarden write is unverified and may have succeeded; do not retry automatically")
      }
    },
  }
}

// The selected executable receives plaintext. It must be trusted with those credentials.
export function childEnvironment(secrets: Record<string, string>, inherited: NodeJS.ProcessEnv = process.env) {
  const env = { ...inherited }
  for (const key of Object.keys(env)) if (/^(BWS_|BW_|OP_)/i.test(key)) delete env[key]
  return { ...env, ...secrets }
}
export function execute(command: readonly string[], values: Record<string, string>): Promise<number> {
  if (!command.length) return Promise.reject(Op.fail("Supply a command after --"))
  return new Promise((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), {
      env: childEnvironment(values),
      stdio: "inherit",
      shell: false,
    })
    child.on("error", () => reject(Op.fail("Could not execute the selected command (details suppressed)")))
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
  })
}
