import { Effect, Schema } from "effect"
import { Op } from "./op.js"

const Summary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  category: Schema.String,
  vault: Schema.Struct({ name: Schema.String }),
})

// Deliberately has no `value`: decoding drops field values before anything else sees them.
const Item = Schema.Struct({
  ...Summary.fields,
  tags: Schema.optionalKey(Schema.Array(Schema.String)),
  urls: Schema.optionalKey(Schema.Array(Schema.Struct({ href: Schema.String }))),
  created_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
  fields: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.optionalKey(Schema.String),
      type: Schema.String,
      purpose: Schema.optionalKey(Schema.String),
      reference: Schema.optionalKey(Schema.String),
      section: Schema.optionalKey(Schema.Struct({ label: Schema.optionalKey(Schema.String) })),
    }),
  ),
})

export interface Scope {
  readonly account?: string | undefined
  readonly vault?: string | undefined
}

// The vault and field are already part of `ref`.
export interface SecretMatch {
  readonly ref: string
  readonly title: string
  readonly kind: string
}

const invalid = () => Op.fail("1Password returned invalid JSON")
const kind = (category: string) => category.toLowerCase().replaceAll("_", "-")

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const distance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    previous = current
  }
  return previous[b.length]!
}

// How close a title comes to a query that matched nothing (0..1): each term
// scores its best title word, so typos like "databse" still find "Database".
const closeness = (terms: ReadonlyArray<string>, title: string) => {
  const candidates = words(title)
  const score = (term: string) =>
    Math.max(
      0,
      ...candidates.map((word) =>
        word.includes(term) || (word.length >= 3 && term.includes(word))
          ? 1
          : 1 - distance(term, word) / Math.max(term.length, word.length),
      ),
    )
  return terms.reduce((sum, term) => sum + score(term), 0) / terms.length
}

const SUGGESTION_THRESHOLD = 0.6
const SUGGESTIONS_PER_MISS = 3

const safeUrl = (input: string): string => {
  try {
    const url = new URL(input)
    return `${url.origin}${url.pathname}`
  } catch {
    return input.split(/[?#]/, 1)[0] ?? ""
  }
}

// `op item get -` prints one JSON document per item, concatenated.
const parseJsonDocuments = (input: string): ReadonlyArray<unknown> => {
  const documents: Array<unknown> = []
  let start = -1
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < input.length; index++) {
    const character = input[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') quoted = false
      continue
    }
    if (character === '"') quoted = true
    else if (character === "{" || character === "[") {
      if (depth === 0) start = index
      depth++
    } else if (character === "}" || character === "]") {
      depth--
      if (depth === 0 && start !== -1) {
        const parsed = JSON.parse(input.slice(start, index + 1))
        if (Array.isArray(parsed)) documents.push(...parsed)
        else documents.push(parsed)
        start = -1
      }
    }
  }
  if (depth !== 0 || quoted) throw new Error("Incomplete JSON document")
  return documents
}

// Lists items once. Entries stay verbatim because `op item get -` accepts them as input.
const list = Effect.fn("list")(function* (scope: Scope) {
  const raw = yield* Op.json(
    Schema.Array(Schema.Unknown),
    ["item", "list", "--format", "json", ...(scope.vault ? ["--vault", scope.vault] : [])],
    { account: scope.account },
  )
  const summaries = yield* Schema.decodeUnknownEffect(Schema.Array(Summary))(raw).pipe(Effect.mapError(invalid))
  return summaries.map((summary, index) => ({ summary, raw: raw[index] }))
})

// Fetches every requested item in one op call, so one authorization prompt covers them all.
const details = Effect.fn("details")(function* (entries: ReadonlyArray<{ readonly raw: unknown }>, scope: Scope) {
  if (entries.length === 0) return []
  const output = yield* Op.op(["item", "get", "-", "--format", "json"], {
    account: scope.account,
    input: `${JSON.stringify(entries.map(({ raw }) => raw))}\n`,
  })
  return yield* Effect.try({ try: () => parseJsonDocuments(output), catch: invalid }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Item))),
    Effect.mapError(invalid),
  )
})

// Matches are listed once, with the queries they answer when several were asked.
// A query that matches nothing returns close titles as suggestions instead,
// fetched in the same batch, so a typo never costs another approval.
export const find = Effect.fn("Discover.find")(function* (queries: ReadonlyArray<string>, scope: Scope = {}) {
  const listed = yield* list(scope)
  const searches = [...new Set(queries)].map((query) => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const items = listed.filter(({ summary }) => terms.every((term) => summary.title.toLowerCase().includes(term)))
    const suggested =
      items.length > 0
        ? []
        : listed
            .map((entry) => ({ entry, score: closeness(terms, entry.summary.title) }))
            .filter(({ score }) => score >= SUGGESTION_THRESHOLD)
            .toSorted((a, b) => b.score - a.score || a.entry.summary.title.localeCompare(b.entry.summary.title))
            .slice(0, SUGGESTIONS_PER_MISS)
            .map(({ entry }) => entry)
    return { query, items, suggested }
  })
  const wanted = listed.filter((entry) =>
    searches.some(({ items, suggested }) => items.includes(entry) || suggested.includes(entry)),
  )
  const secrets = new Map(
    (yield* details(wanted, scope)).map((item) => [
      item.id,
      item.fields.flatMap((field): ReadonlyArray<SecretMatch> =>
        field.reference !== undefined && (field.type === "CONCEALED" || field.purpose === "PASSWORD")
          ? [{ ref: field.reference, title: item.title, kind: kind(item.category) }]
          : [],
      ),
    ]),
  )
  const secretsOf = (items: typeof listed) => items.flatMap(({ summary }) => secrets.get(summary.id) ?? [])
  const matches = new Map<string, SecretMatch & { queries: Array<string> }>()
  for (const { query, items } of searches) {
    for (const match of secretsOf(items)) {
      const existing = matches.get(match.ref)
      if (existing) existing.queries.push(query)
      else matches.set(match.ref, { ...match, queries: [query] })
    }
  }
  const suggestions = searches.flatMap(({ query, suggested }) =>
    secretsOf(suggested).map((match) => ({ query, ...match })),
  )
  return {
    matches: [...matches.values()]
      .map(({ queries: answered, ...match }) => (searches.length === 1 ? match : { ...match, queries: answered }))
      .toSorted((a, b) => a.ref.localeCompare(b.ref)),
    ...(suggestions.length === 0 ? {} : { suggestions }),
  }
})

export const inventory = Effect.fn("Discover.inventory")(function* (scope: Scope = {}) {
  const items = yield* details(yield* list(scope), scope)
  return items
    .map((item) => ({
      id: item.id,
      title: item.title,
      vault: item.vault.name,
      kind: kind(item.category),
      tags: (item.tags ?? []).toSorted(),
      urls: (item.urls ?? []).map(({ href }) => safeUrl(href)),
      ...(item.created_at === undefined ? {} : { createdAt: item.created_at }),
      ...(item.updated_at === undefined ? {} : { updatedAt: item.updated_at }),
      fields: item.fields.map((field) => ({
        label: field.label ?? field.id,
        type: field.type.toLowerCase(),
        ...(field.purpose === undefined ? {} : { purpose: field.purpose.toLowerCase() }),
        ...(field.section?.label === undefined ? {} : { section: field.section.label }),
        ...(field.reference === undefined ? {} : { ref: field.reference }),
      })),
    }))
    .toSorted((a, b) => a.vault.localeCompare(b.vault) || a.title.localeCompare(b.title))
})

const machineKinds = new Set(["api-credential", "database", "document", "password", "secure-note", "ssh-key"])
const transientUrl = /(?:callback|oauth|invite|signup|register|activate|accept|forgot|reset|checkout)/i

export const audit = Effect.fn("Discover.audit")(function* (scope: Scope = {}) {
  const items = yield* inventory(scope)
  const cutoff = new Date()
  cutoff.setFullYear(cutoff.getFullYear() - 5)
  const oldLoginCutoff = cutoff.toISOString()
  return {
    summary: {
      items: items.length,
      tagged: items.filter((item) => item.tags.length > 0).length,
      untagged: items.filter((item) => item.tags.length === 0).length,
    },
    duplicateTitles: [...Map.groupBy(items, (item) => item.title.toLowerCase()).values()]
      .filter((group) => group.length > 1)
      .map((group) => ({ title: group[0]?.title ?? "", items: group.map(({ id, title }) => ({ id, title })) })),
    untaggedMachineCredentials: items
      .filter((item) => item.tags.length === 0 && machineKinds.has(item.kind))
      .map((item) => ({ id: item.id, title: item.title, kind: item.kind })),
    oldLogins: items
      .filter((item) => item.kind === "login" && item.updatedAt !== undefined && item.updatedAt < oldLoginCutoff)
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    urlsToReview: items.flatMap((item) => {
      const urls = item.urls.filter((url) => transientUrl.test(url))
      return urls.length === 0 ? [] : [{ id: item.id, title: item.title, urls }]
    }),
  }
})

export * as Discover from "./discover.js"
