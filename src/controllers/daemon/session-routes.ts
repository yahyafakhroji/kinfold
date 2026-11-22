// The Sessions view's routes: GET /memory/sessions (a page of sessions,
// newest first) and GET /memory/sessions/:id/turns (a page of one session's
// turns). Both sit under /memory/, so they take the token or the dashboard's
// session cookie like the memory browser. An answer holds prompt and reply
// text as stored, which is after the secret scan. Errors name the parameter,
// never echo it; the log line holds counts and a duration, never text.

import type { Database } from '../../resources/sqlite/types'
import { SESSIONS_PAGE, TURNS_PAGE, listSessions, sessionTurns } from '../../resources/store/session-reads'
import type { RouteAnswer } from './data-routes'
import { HOST_PATTERN, MAX_PROJECT_CHARS, optional } from './list-params'

const ID_PATTERN = /^\d{1,15}$/
const TURNS_PATH = /^\/memory\/sessions\/(\d{1,15})\/turns$/
const LIST_KEYS = new Set(['host', 'project', 'before'])
const TURN_KEYS = new Set(['after'])

const bad = (error: string): RouteAnswer => ({ status: 400, body: { error } })

function list(db: Database, params: URLSearchParams, log: (line: string) => void): RouteAnswer {
  if ([...params.keys()].some((key) => !LIST_KEYS.has(key))) return bad('unknown query parameter')
  const host = optional(params, 'host')
  const project = optional(params, 'project')
  const before = optional(params, 'before')
  if (host !== null && !HOST_PATTERN.test(host)) return bad('host must be a short lowercase name')
  if (project !== null && project.length > MAX_PROJECT_CHARS) return bad('project is too long')
  if (before !== null && !ID_PATTERN.test(before)) return bad('before must be a session id')
  const startedAt = performance.now()
  const answer = listSessions(db, { host, project, before: before === null ? null : Number(before), limit: SESSIONS_PAGE })
  log(`sessions list rows=${answer.sessions.length} more=${answer.nextBefore !== null} ms=${Math.round(performance.now() - startedAt)}`)
  return { status: 200, body: answer }
}

function turns(db: Database, sessionId: number, params: URLSearchParams, log: (line: string) => void): RouteAnswer {
  if ([...params.keys()].some((key) => !TURN_KEYS.has(key))) return bad('unknown query parameter')
  const after = optional(params, 'after')
  if (after !== null && !ID_PATTERN.test(after)) return bad('after must be a prompt number')
  const startedAt = performance.now()
  const answer = sessionTurns(db, sessionId, after === null ? 0 : Number(after), TURNS_PAGE)
  if (answer === null) return { status: 404, body: { error: 'no such session' } }
  log(`session turns session=${sessionId} turns=${answer.turns.length} more=${answer.nextAfter !== null} ms=${Math.round(performance.now() - startedAt)}`)
  return { status: 200, body: answer }
}

/** Null when the path is not a sessions route, so the caller goes on to the other /memory routes. */
export function sessionRoute(method: string, url: URL, db: Database, log: (line: string) => void): RouteAnswer | null {
  const path = url.pathname
  const detail = TURNS_PATH.exec(path)
  if (path !== '/memory/sessions' && detail === null) return null
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
  return detail === null ? list(db, url.searchParams, log) : turns(db, Number(detail[1]), url.searchParams, log)
}
