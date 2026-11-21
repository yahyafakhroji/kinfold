// Asks the running daemon for a context pack. This module imports only Node
// builtins, so the standalone OpenCode plugin can carry it without SQLite.
// Never throws: a missing daemon, a refused request or a malformed reply is a
// reason for the caller to log, and no result.

import { readDaemonEndpoint } from '../daemon/daemon-info'
import { type ContextRequest, type ContextResult, parseContextResult } from './types'

export const DAEMON_SHARE_MS = 200
/**
 * A cold daemon resolves a project's git key before the first pack, which can
 * take longer than the hook's share of the budget. The plugin has no stored
 * pack to fall back to, so it waits for that first answer instead of adding
 * nothing for the whole session.
 */
export const DAEMON_ONLY_TIMEOUT_MS = 1_000

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/** Why the daemon gave no result; `answered` is true when it replied but refused or sent something unusable. */
export interface DaemonMiss {
  reason: string
  answered: boolean
  /** No daemon is listening (no endpoint file, or the connection was refused), as opposed to one that was too slow or refused the request. */
  down: boolean
}

export interface DaemonContextOptions {
  timeoutMs?: number
  fetch?: FetchFn
  now?: () => number
  log?: (line: string) => void
}

export async function askDaemon(dataDir: string, request: ContextRequest, timeoutMs: number, fetchFn: FetchFn): Promise<ContextResult | DaemonMiss> {
  const endpoint = readDaemonEndpoint(dataDir)
  if (endpoint === null) return { reason: 'daemon not running', answered: false, down: true }
  try {
    const response = await fetchFn(`http://127.0.0.1:${endpoint.port}/context`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
      // The daemon never redirects; following one would hand the token and the prompt to another address.
      redirect: 'error',
    })
    if (response.status !== 200) return { reason: `daemon answered ${response.status}`, answered: true, down: false }
    return parseContextResult(await response.json()) ?? { reason: 'daemon reply malformed', answered: true, down: false }
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : 'unknown error'
    // A timeout means something is listening and was slow; any other failure to connect means nothing is.
    return { reason: `daemon unreachable: ${name}`, answered: false, down: name !== 'TimeoutError' && name !== 'AbortError' }
  }
}

/** The daemon's answer alone: a down daemon means no context, never a read of the store. */
export async function fetchDaemonContext(dataDir: string, request: ContextRequest, options: DaemonContextOptions = {}): Promise<ContextResult | null> {
  const startedAt = (options.now ?? Date.now)()
  const answer = await askDaemon(dataDir, request, options.timeoutMs ?? DAEMON_ONLY_TIMEOUT_MS, options.fetch ?? fetch)
  if ('reason' in answer) {
    options.log?.(`context: ${answer.reason} ms=${(options.now ?? Date.now)() - startedAt}`)
    return null
  }
  return answer
}
