// How a host gets its pack: ask the daemon (POST /context), and if it is down,
// slow or broken, read the stored pack read-only. Both together get one hard
// budget (300 ms): the daemon gets at most DAEMON_SHARE_MS of it, so a hung
// daemon still leaves the fallback time to run, and a result that lands after
// the budget is dropped. Never throws: a host sees a result or null.

import { readDaemonEndpoint } from '../daemon/daemon-info'
import { readStoredContext } from './fallback'
import { type ContextRequest, type ContextResult, parseContextResult } from './types'

export const CONTEXT_BUDGET_MS = 300
export const DAEMON_SHARE_MS = 200
/** Below this the fallback is not worth starting: opening SQLite and asking git take longer. */
export const MIN_FALLBACK_MS = 20

export type ContextSource = 'daemon' | 'fallback' | 'none'

export interface ContextFetch {
  source: ContextSource
  result: ContextResult | null
  ms: number
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface ContextClientOptions {
  budgetMs?: number
  daemonShareMs?: number
  log?: (line: string) => void
  fetch?: FetchFn
  now?: () => number
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
}

/** Why the daemon gave no result; `answered` is true when it replied but refused or sent something unusable. */
interface DaemonMiss {
  reason: string
  answered: boolean
}

async function askDaemon(dataDir: string, request: ContextRequest, timeoutMs: number, fetchFn: FetchFn): Promise<ContextResult | DaemonMiss> {
  const endpoint = readDaemonEndpoint(dataDir)
  if (endpoint === null) return { reason: 'daemon not running', answered: false }
  try {
    const response = await fetchFn(`http://127.0.0.1:${endpoint.port}/context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status !== 200) return { reason: `daemon answered ${response.status}`, answered: true }
    return parseContextResult(await response.json()) ?? { reason: 'daemon reply malformed', answered: true }
  } catch (error: unknown) {
    return { reason: `daemon unreachable: ${errorName(error)}`, answered: false }
  }
}

const isMiss = (value: ContextResult | DaemonMiss): value is DaemonMiss => 'reason' in value

/**
 * A prompt delta from the read-only path is not recorded, so the next prompt
 * would send it again. That is worth it only while the daemon is down; a
 * daemon that answered and refused (an older build without the prompt
 * channel, say) gets no fallback, or every prompt would repeat the delta.
 */
function mayFallBack(request: ContextRequest, miss: DaemonMiss): boolean {
  return request.channel !== 'prompt' || !miss.answered
}

function runFallback(dataDir: string, request: ContextRequest, budgetMs: number, log: (line: string) => void): ContextResult | null {
  try {
    return readStoredContext(dataDir, request, { budgetMs, log })
  } catch (error: unknown) {
    log(`context fallback failed: ${errorName(error)}`)
    return null
  }
}

export async function fetchContext(dataDir: string, request: ContextRequest, options: ContextClientOptions = {}): Promise<ContextFetch> {
  const now = options.now ?? Date.now
  const log = options.log ?? (() => {})
  const budget = options.budgetMs ?? CONTEXT_BUDGET_MS
  const startedAt = now()
  const elapsed = (): number => now() - startedAt
  const none = (): ContextFetch => ({ source: 'none', result: null, ms: elapsed() })

  const daemon = await askDaemon(dataDir, request, Math.min(options.daemonShareMs ?? DAEMON_SHARE_MS, budget), options.fetch ?? fetch)
  if (!isMiss(daemon)) return { source: 'daemon', result: daemon, ms: elapsed() }
  if (!mayFallBack(request, daemon)) {
    log(`context: ${daemon.reason}; no fallback for the prompt channel`)
    return none()
  }
  log(`context: ${daemon.reason}; trying the read-only fallback`)

  const left = budget - elapsed()
  if (left < MIN_FALLBACK_MS) return none()
  const stored = runFallback(dataDir, request, left, log)
  if (elapsed() > budget) {
    log(`context: fallback finished past the budget ms=${elapsed()}; nothing injected`)
    return none()
  }
  return stored === null ? none() : { source: 'fallback', result: stored, ms: elapsed() }
}
