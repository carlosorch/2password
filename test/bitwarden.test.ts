import { describe, expect, it, vi } from "vitest"
import { backend, childEnvironment, execute, parseAssignment, secretId, type Transport } from "../src/bitwarden.js"

const organization = "11111111-1111-1111-1111-111111111111"
const project = "22222222-2222-2222-2222-222222222222"
const id = "33333333-3333-3333-3333-333333333333"
const ref = `bws://${id}`
const sentinel = "FICTIONAL_SECRET_DO_NOT_PRINT"
const record = {
  id,
  key: "OPENAI_API_KEY",
  organizationId: organization,
  projectId: project,
  value: sentinel,
  note: "",
}
const options = { organization, project, key: record.key, value: sentinel, note: "" }

describe("Bitwarden Secrets Manager", () => {
  it("returns allowlisted metadata, even if the SDK includes values and notes", async () => {
    const send = vi.fn<Transport>().mockResolvedValue({ data: [{ ...record, note: sentinel }] })
    const api = backend(send)
    expect(JSON.stringify(await api.inventory(organization))).not.toContain(sentinel)
    expect(await api.find(["openai", "missing"], organization)).toEqual({
      matches: [
        { query: "openai", items: [{ id, key: record.key, organizationId: organization, reference: ref }] },
        { query: "missing", items: [] },
      ],
    })
  })
  it("sanitizes SDK errors without echoing tokens, values or server responses", async () => {
    const api = backend(async () => {
      throw new Error(sentinel)
    })
    await expect(api.read(ref)).rejects.toThrow("details suppressed")
    const error = await api.inventory(organization).catch((failure: unknown) => failure)
    expect(String(error)).not.toContain(sentinel)
  })
  it("explicit read is the only API result that reveals a value", async () => {
    expect(await backend(async () => record).read(ref)).toBe(sentinel)
  })
  it("rejects malformed references and process-control names before fetching", async () => {
    for (const value of ["op://Personal/key", "bws://../secret", "bws://not-a-uuid", `bws://${id}/field`])
      expect(() => secretId(value)).toThrow("Expected bws://")
    for (const name of [
      "BWS_ACCESS_TOKEN",
      "BW_SESSION",
      "OP_SERVICE_ACCOUNT_TOKEN",
      "LD_PRELOAD",
      "PATH",
      "NODE_OPTIONS",
      "BASH_ENV",
      "a-b",
    ])
      expect(() => parseAssignment(`${name}=${ref}`)).toThrow(/Expected|cannot/)
    expect(parseAssignment(`OPENAI_API_KEY=${ref}`)).toEqual({ name: "OPENAI_API_KEY", id })
  })
  it("batches reads and requires every requested secret before execution", async () => {
    const send = vi.fn<Transport>().mockResolvedValue({ data: [record] })
    const api = backend(send)
    expect(
      await api.resolve([
        { name: "ONE", id },
        { name: "TWO", id },
      ]),
    ).toEqual({ ONE: sentinel, TWO: sentinel })
    expect(send).toHaveBeenCalledExactlyOnceWith({ operation: "getByIds", ids: [id] })
    await expect(backend(async () => ({ data: [] })).resolve([{ name: "ONE", id }])).rejects.toThrow("unavailable")
    await expect(
      api.resolve([
        { name: "ONE", id },
        { name: "ONE", id },
      ]),
    ).rejects.toThrow("unique")
    await expect(api.resolve([{ name: "BW_SESSION", id }])).rejects.toThrow("cannot")
  })
  it("rejects duplicates, wrong IDs and wrong organizations from the server", async () => {
    await expect(backend(async () => ({ data: [record, record] })).resolve([{ name: "ONE", id }])).rejects.toThrow(
      "Unexpected",
    )
    await expect(backend(async () => ({ ...record, id: project })).read(ref)).rejects.toThrow("different secret")
    await expect(
      backend(async () => ({ data: [{ ...record, organizationId: project }] })).inventory(organization),
    ).rejects.toThrow("different organization")
  })
  it("creates once, reads back, and returns no value", async () => {
    const send = vi.fn<Transport>().mockResolvedValueOnce({ data: [] }).mockResolvedValue(record)
    const receipt = await backend(send).write(options)
    expect(receipt.verified).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain(sentinel)
    expect(send.mock.calls.map(([request]) => request.operation)).toEqual(["list", "create", "get"])
  })
  it("never retries an uncertain write and suppresses secret-bearing errors", async () => {
    const send = vi.fn<Transport>().mockResolvedValueOnce({ data: [] }).mockRejectedValue(new Error(sentinel))
    await expect(backend(send).write(options)).rejects.toThrow("unverified")
    expect(send).toHaveBeenCalledTimes(2)
  })
  it("rejects duplicate names without writing", async () => {
    const send = vi.fn<Transport>().mockResolvedValue({ data: [record] })
    await expect(backend(send).write(options)).rejects.toThrow("already exists")
    expect(send).toHaveBeenCalledTimes(1)
  })
  it("rejects failed readback, including wrong destinations and notes", async () => {
    for (const changed of [
      { value: "wrong" },
      { key: "wrong" },
      { projectId: organization },
      { organizationId: project },
      { note: "wrong" },
    ]) {
      const send = vi
        .fn<Transport>()
        .mockResolvedValueOnce({ data: [] })
        .mockResolvedValueOnce(record)
        .mockResolvedValueOnce({ ...record, ...changed })
      await expect(backend(send).write(options)).rejects.toThrow("do not retry")
      expect(send).toHaveBeenCalledTimes(3)
    }
  })
  it("checks update destination before writing and verifies afterward", async () => {
    const send = vi.fn<Transport>().mockResolvedValue(record)
    await backend(send).write({ ...options, ref })
    expect(send.mock.calls.map(([request]) => request.operation)).toEqual(["get", "update", "get"])
    const wrong = vi.fn<Transport>().mockResolvedValue({ ...record, projectId: organization })
    await expect(backend(wrong).write({ ...options, ref })).rejects.toThrow("nothing written")
    expect(wrong).toHaveBeenCalledTimes(1)
  })
  it("executes without a shell, preserves literal arguments and propagates exit codes", async () => {
    const argument = "$(do-not-execute); literal & argument"
    const code = await execute(
      [
        process.execPath,
        "-e",
        "process.exit(process.env.KEY === 'FICTIONAL_SECRET_DO_NOT_PRINT' && process.argv[1] === '$(do-not-execute); literal & argument' ? 23 : 1)",
        argument,
      ],
      { KEY: sentinel },
    )
    expect(code).toBe(23)
    await expect(execute(["2password-nonexistent-executable"], { KEY: sentinel })).rejects.toThrow("details suppressed")
  })
  it("does not give the child machine tokens or personal vault sessions", () => {
    expect(
      childEnvironment(
        { OPENAI_API_KEY: sentinel },
        {
          BWS_ACCESS_TOKEN: sentinel,
          BWS_OTHER: sentinel,
          bws_access_token: sentinel,
          BW_SESSION: sentinel,
          OP_SERVICE_ACCOUNT_TOKEN: sentinel,
          OP_CONNECT_TOKEN: sentinel,
          PATH: "/usr/bin",
          HOME: "/home/test",
        },
      ),
    ).toEqual({ OPENAI_API_KEY: sentinel, PATH: "/usr/bin", HOME: "/home/test" })
  })
})
