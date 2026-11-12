// The vector half of hybrid search, served by the daemon on
// POST /search/semantic: embed the query, then the nearest observations of
// the project. The embed is the slow part (a round trip to OpenRouter), so
// it runs under the caller's deadline and recent query vectors stay in an
// in-memory LRU: an agent paging through results, or retrying, pays once.
// Query text lives only in that map and the embed call; it is never logged
// or stored. An answer is ok with hits, timeout, or unavailable with the
// reason (no extension, no key, no vectors yet), and callers fall back to FTS.

import type { Parsed } from '../context/types'
import { isRecord } from '../contract/event'
import type { Database } from '../sqlite/types'
import { NO_FILTERS, type NearestFilters, type VectorHit } from '../store/vector-store'
import { EmbedError, type Embedder } from './embedder'
import type { Support } from './extension'
import { type VectorQueries, inlineVectorQueries } from './vector-worker'

export const MAX_QUERY_CHARS = 2_000
export const MAX_K = 100
export const DEFAULT_DEADLINE_MS = 1_500
export const MAX_DEADLINE_MS = 5_000
export const QUERY_CACHE_SIZE = 64

export interface SemanticRequest {
  query: string
  /** Null: every project. */
  project: string | null
  k: number
  deadlineMs: number
  /** The MCP search filters, applied before the top k. */
  filters: NearestFilters
  /** Rows to measure as well, after the top k: the prompt path's keyword candidates. */
  alsoIds?: readonly number[]
  /**
   * When the caller stops waiting, from the request's start. Set by callers
   * that abort at their deadline (the MCP routes); unset, a read may run late,
   * as the prompt path wants for its late answers.
   */
  giveUpMs?: number
}

export type SemanticAnswer =
  | { status: 'ok'; hits: VectorHit[]; embedMs: number; searchMs: number; cached: boolean }
  | { status: 'timeout'; ms: number }
  | { status: 'unavailable'; reason: string }

export interface SemanticSearchDeps {
  db: Database
  /** Null without an OpenRouter key. */
  embedder: Embedder | null
  /** Whether sqlite-vec loaded into db, and why not. */
  support: Support
  /** Where the vector reads run; default db on the caller's thread. The daemon passes its search worker. */
  queries?: VectorQueries
  now?: () => number
}

function isIntIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max
}

const MAX_FILTER_CHARS = 64

function parseFilters(value: unknown): NearestFilters | null {
  if (value === undefined) return NO_FILTERS
  if (!isRecord(value)) return null
  const field = (name: keyof NearestFilters): string | null | undefined => {
    const raw = value[name]
    if (raw === undefined || raw === null) return null
    return typeof raw === 'string' && raw !== '' && raw.length <= MAX_FILTER_CHARS ? raw : undefined
  }
  const type = field('type')
  const host = field('host')
  const evidence = field('evidence')
  return type === undefined || host === undefined || evidence === undefined ? null : { type, host, evidence }
}

export function parseSemanticRequest(body: unknown): Parsed<SemanticRequest> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  const { query, project, k } = body
  const deadlineMs = body.deadlineMs ?? DEFAULT_DEADLINE_MS
  if (typeof query !== 'string' || query.trim() === '' || query.length > MAX_QUERY_CHARS) {
    return { ok: false, error: `query must be a non-empty string of at most ${MAX_QUERY_CHARS} chars` }
  }
  if (project !== null && (typeof project !== 'string' || project === '')) return { ok: false, error: 'project must be a key or null' }
  if (!isIntIn(k, 1, MAX_K)) return { ok: false, error: `k must be an integer from 1 to ${MAX_K}` }
  if (!isIntIn(deadlineMs, 1, MAX_DEADLINE_MS)) return { ok: false, error: `deadlineMs must be an integer from 1 to ${MAX_DEADLINE_MS}` }
  const filters = parseFilters(body.filters)
  if (filters === null) return { ok: false, error: `filters must be an object of type, host and evidence, each null or a string of at most ${MAX_FILTER_CHARS} chars` }
  return { ok: true, value: { query: query.trim(), project, k, deadlineMs, filters } }
}

interface QueryCache {
  get(key: string): Float32Array | undefined
  set(key: string, value: Float32Array): void
}

/** Least recently used goes first; Map keeps insertion order, so a hit is re-inserted. */
function createQueryCache(size: number): QueryCache {
  const entries = new Map<string, Float32Array>()
  return {
    get: (key) => {
      const value = entries.get(key)
      if (value !== undefined) {
        entries.delete(key)
        entries.set(key, value)
      }
      return value
    },
    set: (key, value) => {
      entries.delete(key)
      entries.set(key, value)
      if (entries.size > size) entries.delete(entries.keys().next().value!)
    },
  }
}

type Embedded = { ok: true; vector: Float32Array; cached: boolean } | { ok: false; answer: SemanticAnswer }

async function queryVector(embedder: Embedder, cache: QueryCache, request: SemanticRequest, elapsed: () => number): Promise<Embedded> {
  const hit = cache.get(request.query)
  if (hit !== undefined) return { ok: true, vector: hit, cached: true }
  try {
    const [vector] = await embedder.embed([request.query], AbortSignal.timeout(request.deadlineMs))
    cache.set(request.query, vector!)
    return { ok: true, vector: vector!, cached: false }
  } catch (error: unknown) {
    if (error instanceof EmbedError && error.kind === 'timeout') return { ok: false, answer: { status: 'timeout', ms: Math.round(elapsed()) } }
    const why = error instanceof Error ? error.message : 'error'
    return { ok: false, answer: { status: 'unavailable', reason: `the query could not be embedded (${why})` } }
  }
}

export function createSemanticSearch(deps: SemanticSearchDeps): (request: SemanticRequest) => Promise<SemanticAnswer> {
  const now = deps.now ?? (() => performance.now())
  const cache = createQueryCache(QUERY_CACHE_SIZE)
  const queries = deps.queries ?? inlineVectorQueries(deps.db)
  return async (request) => {
    if (!deps.support.ok) return { status: 'unavailable', reason: deps.support.reason }
    const embedder = deps.embedder
    if (embedder === null) return { status: 'unavailable', reason: 'no OpenRouter key in the keychain for embeddings' }
    const startedAt = now()
    const embedded = await queryVector(embedder, cache, request, () => now() - startedAt)
    if (!embedded.ok) return embedded.answer
    const embeddedAt = now()
    try {
      const left = (): number | undefined => (request.giveUpMs === undefined ? undefined : request.giveUpMs - (now() - startedAt))
      const nearest = await queries.nearest({ model: embedder.model, vector: embedded.vector, project: request.project, k: request.k, filters: request.filters }, left())
      if (nearest === null) return { status: 'timeout', ms: Math.round(now() - startedAt) }
      const found = new Set(nearest.map((hit) => hit.id))
      const ids = request.alsoIds?.filter((id) => !found.has(id)) ?? []
      const extra = ids.length === 0 ? [] : await queries.distances({ model: embedder.model, vector: embedded.vector, project: request.project, ids }, left())
      if (extra === null) return { status: 'timeout', ms: Math.round(now() - startedAt) }
      return { status: 'ok', hits: [...nearest, ...extra], embedMs: Math.round(embeddedAt - startedAt), searchMs: Math.round(now() - embeddedAt), cached: embedded.cached }
    } catch (error: unknown) {
      return { status: 'unavailable', reason: error instanceof Error ? error.message : 'the vector search failed' }
    }
  }
}
