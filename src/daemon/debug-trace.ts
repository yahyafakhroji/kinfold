// The daemon's side of `kinfold watch --debug` beyond the prompt route: the
// turn's real usage beside what Kinfold added to it, what the observer did
// with a session's events, and GET /watch/debug, which reads the in-memory
// trace. Everything here reads ids and numbers; nothing is written.

import type { ObserverTrace, TraceBuffer, TurnTrace } from '../debug/trace'
import type { BatchOutcome } from '../observer/process'
import type { Database } from '../sqlite/types'
import { projectDisplayName } from '../store/context-store'
import { HOST_PATTERN, MAX_PROJECT_CHARS } from '../watch/reads'
import type { RouteAnswer } from './data-routes'
import type { TurnEnd, TurnUsage } from './transcript-usage'

interface SessionRow {
  host: string
  hostSessionId: string
  projectKey: string
}

function sessionRow(db: Database, sessionId: number): SessionRow | null {
  return db.query<SessionRow, [number]>('SELECT host, host_session_id AS hostSessionId, project_key AS projectKey FROM sessions WHERE id = ?').get(sessionId) ?? null
}

/** Null for a session the store no longer has. */
export function turnTrace(db: Database, turn: TurnEnd, usage: TurnUsage | null): TurnTrace | null {
  const session = sessionRow(db, turn.sessionId)
  if (session === null) return null
  const added = db.query<{ tokens: number }, Record<string, string | number>>(
    `SELECT coalesce(sum(tokens), 0) AS tokens FROM injections
     WHERE host = $host AND host_session_id = $hostSessionId AND channel = 'prompt' AND prompt_number = $promptNumber`,
  ).get({ host: session.host, hostSessionId: session.hostSessionId, promptNumber: turn.promptNumber })
  return {
    kind: 'turn', at: turn.occurredAt, host: session.host, project: projectDisplayName(db, session.projectKey) ?? session.projectKey, projectKey: session.projectKey,
    hostSessionId: session.hostSessionId, promptNumber: turn.promptNumber, usage, kinfoldTokens: added?.tokens ?? 0,
  }
}

/** An idle look found nothing to do, so it is not an event. */
export function observerTrace(db: Database, sessionId: number, outcome: BatchOutcome, at: number): ObserverTrace | null {
  if (outcome.status === 'idle') return null
  const session = sessionRow(db, sessionId)
  if (session === null) return null
  const events = 'events' in outcome ? outcome.events : 0
  const written = outcome.status === 'succeeded' ? outcome.inserted : 0
  return {
    kind: 'observer', at, host: session.host, project: projectDisplayName(db, session.projectKey) ?? session.projectKey, projectKey: session.projectKey,
    hostSessionId: session.hostSessionId, status: outcome.status, events, written,
  }
}

/**
 * GET /watch/debug[?after=<seq>][&host=][&project=] (token only). Without
 * `after` it answers the cursor and no events, so a watcher starts from now.
 * Each read also tells the daemon a debug watcher is connected.
 */
export function debugWatchRoute(trace: TraceBuffer, method: string, url: URL, now: number): RouteAnswer {
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
  const after = url.searchParams.get('after')
  const host = url.searchParams.get('host')
  const project = url.searchParams.get('project')
  if (after !== null && !/^\d{1,15}$/.test(after)) return { status: 400, body: { error: 'after must be a trace cursor' } }
  if (host !== null && !HOST_PATTERN.test(host)) return { status: 400, body: { error: 'host must be an agent id' } }
  if (project !== null && (project === '' || project.length > MAX_PROJECT_CHARS)) return { status: 400, body: { error: 'project must be a name or key' } }
  return { status: 200, body: trace.read({ after: after === null ? null : Number(after), host, project }, now) }
}
