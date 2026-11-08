// How a host gets its pack: ask the daemon (POST /context), and if it is down,
// slow or broken, read the stored pack read-only. Both together get one hard
// budget (300 ms): the daemon gets at most DAEMON_SHARE_MS of it, so a hung
// daemon still leaves the fallback time to run, and a result that lands after
// the budget is dropped. A compiled program has no SQLite in its hook, so it
// asks the daemon only. Never throws: a host sees a result or null.

import { isCompiledProgram } from '../runtime/program'
import { type DaemonMiss, DAEMON_SHARE_MS, type FetchFn, askDaemon } from './daemon'
import { readStoredContext } from './fallback'
import { type ContextRequest, type ContextResult } from './types'

export { DAEMON_SHARE_MS, type FetchFn } from './daemon'

export const CONTEXT_BUDGET_MS = 300
/** Below this the fallback is not worth starting: opening SQLite and asking git take longer. */
export const MIN_FALLBACK_MS = 20

export type ContextSource = 'daemon' | 'fallback' | 'none'

export interface ContextFetch {
  source: ContextSource
  result: ContextResult | null
  ms: number
}

export interface ContextClientOptions {
  budgetMs?: number
  daemonShareMs?: number
  log?: (line: string) => void
  fetch?: FetchFn
  now?: () => number
  /** True when the stored pack may be read after the daemon misses; a compiled program's hook uses false. */
  fallback?: boolean
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error'
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
  if (!(options.fallback ?? !isCompiledProgram())) {
    log(`context: ${daemon.reason}; no read-only fallback in a compiled program`)
    return none()
  }
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
