// The MCP server's way to the vector half of hybrid search. The
// server stays read-only and extension-free: it posts the query to the
// daemon's POST /search/semantic with the data-dir token, under a deadline,
// and merges what comes back with its own FTS results. A daemon that is
// down, slow or refusing gives an "unavailable" or "timeout" answer and the
// search runs on FTS alone; this never throws. The query goes to the daemon
// only and is never logged here.

import { readDaemonEndpoint } from '../daemon/daemon-info'
import { isRecord } from '../contract/event'
import type { NearestFilters, VectorHit } from '../store/vector-store'
import type { SemanticAnswer } from '../vectors/search'

/** Off the prompt path, so more than the 300 ms prompt-time budget; the daemon gets most of it for the embed. */
export const MCP_SEMANTIC_TIMEOUT_MS = 1_500
const DAEMON_MARGIN_MS = 150

export type SemanticFetch = (url: string, init: RequestInit) => Promise<Response>

export interface SemanticQuery {
  query: string
  project: string | null
  k: number
  filters: NearestFilters
}

export type SemanticClient = (query: SemanticQuery) => Promise<SemanticAnswer>

export interface SemanticClientOptions {
  dataDir: string
  fetch?: SemanticFetch
  timeoutMs?: number
}

function isHit(value: unknown): value is VectorHit {
  return isRecord(value) && Number.isSafeInteger(value.id) && typeof value.distance === 'number' && Number.isFinite(value.distance)
}

function numberOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Only the shapes the daemon sends; anything else is unavailable. */
export function parseSemanticAnswer(value: unknown): SemanticAnswer {
  if (!isRecord(value)) return { status: 'unavailable', reason: 'the daemon sent an answer this server does not understand' }
  if (value.status === 'ok' && Array.isArray(value.hits) && value.hits.every(isHit)) {
    return { status: 'ok', hits: value.hits, embedMs: numberOr0(value.embedMs), searchMs: numberOr0(value.searchMs), cached: value.cached === true }
  }
  if (value.status === 'timeout') return { status: 'timeout', ms: numberOr0(value.ms) }
  if (value.status === 'unavailable' && typeof value.reason === 'string') return { status: 'unavailable', reason: value.reason.slice(0, 300) }
  return { status: 'unavailable', reason: 'the daemon sent an answer this server does not understand' }
}

export function createSemanticClient(options: SemanticClientOptions): SemanticClient {
  const fetchFn = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? MCP_SEMANTIC_TIMEOUT_MS
  return async (query) => {
    const endpoint = readDaemonEndpoint(options.dataDir)
    if (endpoint === null) return { status: 'unavailable', reason: 'the daemon is not running' }
    try {
      const response = await fetchFn(`http://127.0.0.1:${endpoint.port}/search/semantic`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...query, deadlineMs: Math.max(1, timeoutMs - DAEMON_MARGIN_MS) }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) return { status: 'unavailable', reason: `the daemon answered ${response.status}` }
      return parseSemanticAnswer(await response.json())
    } catch (error: unknown) {
      const name = error instanceof Error ? error.name : 'error'
      if (name === 'TimeoutError' || name === 'AbortError') return { status: 'timeout', ms: timeoutMs }
      return { status: 'unavailable', reason: `the daemon could not be reached (${name})` }
    }
  }
}
