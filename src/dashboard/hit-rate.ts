// Two proxies for "is injected memory used?" (P1-H), pure over stored rows.
// Neither proves use: an agent can act on an injected line without fetching
// it, and can fetch an id it found by search rather than from the injection.
// The page and the report say so.
//
// fetch-after-inject: of the distinct (project, observation id) pairs
// injected in the window, the share that an MCP get_observations call in the
// same project (or a call scoped to every project, '*') returned within
// FETCH_HORIZON_MS after any injection of that pair. A read that came before
// every injection of the pair does not count.
//
// search-hit: of the MCP search calls in the window that ran (status ok),
// the share that returned at least one row.
//
// related-by-distance (P2-B labels): of the related lines served at prompt
// time, by the distance that earned them, the share an MCP get_observations
// call in the project returned within FETCH_HORIZON_MS. The same proxy, kept
// per distance band, so the gate's cutoffs can be checked against use.

import type { InjectedIds, StoredMcpRead } from '../store/mcp-read-store'
import type { StoredRelated } from '../store/related-served-store'

export const FETCH_HORIZON_MS = 24 * 3_600_000

export interface FetchAfterInject {
  /** Distinct (project, id) pairs injected in the window. */
  injected: number
  /** Of those, the pairs fetched within the horizon. */
  fetched: number
  /** fetched / injected; null when nothing was injected. */
  rate: number | null
  horizonMs: number
}

export interface SearchHit {
  /** Search calls that ran (status ok). */
  searches: number
  withRows: number
  rate: number | null
}

export interface McpReadGroup {
  /** 'unknown' when the MCP entry did not set KINFOLD_MCP_HOST. */
  host: string
  tool: string
  calls: number
  /** Calls whose status was not ok or not_found. */
  errors: number
}

export interface RelatedBand {
  /** `keyword only` (no distance), or a distance range such as `0.35-0.50`. */
  band: string
  served: number
  fetched: number
  rate: number | null
}

export interface HitRateSummary {
  fetchAfterInject: FetchAfterInject
  searchHit: SearchHit
  reads: McpReadGroup[]
  relatedByDistance: RelatedBand[]
}

/** Bands on the gate's own cutoffs (src/context/related.ts): strong, supported, up to the veto. */
export const RELATED_BANDS: readonly { band: string; test: (distance: number | null) => boolean }[] = [
  { band: 'keyword only', test: (d) => d === null },
  { band: '0.00-0.35', test: (d) => d !== null && d <= 0.35 },
  { band: '0.35-0.50', test: (d) => d !== null && d > 0.35 && d <= 0.5 },
  { band: '0.50-0.70', test: (d) => d !== null && d > 0.5 },
]

interface Fetch {
  projectKey: string
  at: number
}

const ratio = (part: number, whole: number): number | null => (whole === 0 ? null : part / whole)

/** pair key -> every time that pair was injected. */
function injectionTimes(injections: readonly InjectedIds[]): Map<string, { project: string; id: number; times: number[] }> {
  const pairs = new Map<string, { project: string; id: number; times: number[] }>()
  for (const row of injections) {
    for (const id of row.observationIds) {
      const key = JSON.stringify([row.projectKey, id])
      const pair = pairs.get(key) ?? { project: row.projectKey, id, times: [] }
      pairs.set(key, { ...pair, times: [...pair.times, row.occurredAt] })
    }
  }
  return pairs
}

/** observation id -> the successful get_observations calls that returned it. */
function fetchesById(reads: readonly StoredMcpRead[]): Map<number, Fetch[]> {
  const byId = new Map<number, Fetch[]>()
  for (const read of reads) {
    if (read.tool !== 'get_observations' || read.status !== 'ok') continue
    for (const id of read.returnedIds) byId.set(id, [...(byId.get(id) ?? []), { projectKey: read.projectKey, at: read.occurredAt }])
  }
  return byId
}

export function fetchAfterInject(injections: readonly InjectedIds[], reads: readonly StoredMcpRead[], horizonMs: number = FETCH_HORIZON_MS): FetchAfterInject {
  const pairs = injectionTimes(injections)
  const fetches = fetchesById(reads)
  let fetched = 0
  for (const pair of pairs.values()) {
    const matching = (fetches.get(pair.id) ?? []).filter((fetch) => fetch.projectKey === pair.project || fetch.projectKey === '*')
    if (pair.times.some((at) => matching.some((fetch) => fetch.at >= at && fetch.at <= at + horizonMs))) fetched += 1
  }
  return { injected: pairs.size, fetched, rate: ratio(fetched, pairs.size), horizonMs }
}

export function searchHit(reads: readonly StoredMcpRead[]): SearchHit {
  const searches = reads.filter((read) => read.tool === 'search' && read.status === 'ok')
  const withRows = searches.filter((read) => read.rows >= 1).length
  return { searches: searches.length, withRows, rate: ratio(withRows, searches.length) }
}

export function groupReads(reads: readonly StoredMcpRead[]): McpReadGroup[] {
  const key = (read: StoredMcpRead): string => JSON.stringify([read.host ?? 'unknown', read.tool])
  return [...new Set(reads.map(key))].sort().map((k) => {
    const [host, tool] = JSON.parse(k) as [string, string]
    const rows = reads.filter((read) => key(read) === k)
    return { host, tool, calls: rows.length, errors: rows.filter((read) => read.status !== 'ok' && read.status !== 'not_found').length }
  })
}

/** Each served line counts once; it is fetched when a get_observations call in its project (or '*') returned it within the horizon. */
export function relatedByDistance(served: readonly StoredRelated[], reads: readonly StoredMcpRead[], horizonMs: number = FETCH_HORIZON_MS): RelatedBand[] {
  const fetches = fetchesById(reads)
  return RELATED_BANDS.map(({ band, test }) => {
    const rows = served.filter((row) => test(row.distance))
    const fetched = rows.filter((row) => (fetches.get(row.observationId) ?? [])
      .some((fetch) => (fetch.projectKey === row.projectKey || fetch.projectKey === '*') && fetch.at >= row.occurredAt && fetch.at <= row.occurredAt + horizonMs)).length
    return { band, served: rows.length, fetched, rate: ratio(fetched, rows.length) }
  })
}

/** Injections and reads both from the window start: a read before it cannot follow an injection inside it. */
export function summarizeHitRate(injections: readonly InjectedIds[], reads: readonly StoredMcpRead[], related: readonly StoredRelated[] = []): HitRateSummary {
  return { fetchAfterInject: fetchAfterInject(injections, reads), searchHit: searchHit(reads), reads: groupReads(reads), relatedByDistance: relatedByDistance(related, reads) }
}
