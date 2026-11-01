// Read queries the daemon serves. P0 only needs the verification listing;
// the context-pack and search reads arrive with task 8.

import type { Database } from '../sqlite/types'

export interface SessionSummary {
  id: number
  host: string
  hostSessionId: string
  projectKey: string
  cwd: string
  startedAt: number
  endedAt: number | null
  lastEventAt: number
  eventCount: number
}

export const DEFAULT_SESSION_LIMIT = 50

const SESSION_COLUMNS = `
  s.id, s.host, s.host_session_id AS hostSessionId, s.project_key AS projectKey, s.cwd,
  s.started_at AS startedAt, s.ended_at AS endedAt, s.last_event_at AS lastEventAt,
  (SELECT count(*) FROM events e WHERE e.session_id = s.id) AS eventCount`

/** Most recently active first. Without a project, lists across all projects. */
export function listRecentSessions(db: Database, projectKey: string | null, limit: number = DEFAULT_SESSION_LIMIT): SessionSummary[] {
  if (projectKey === null) {
    return db.query<SessionSummary, { limit: number }>(
      `SELECT ${SESSION_COLUMNS} FROM sessions s ORDER BY s.last_event_at DESC LIMIT $limit`,
    ).all({ limit })
  }
  return db.query<SessionSummary, { projectKey: string; limit: number }>(
    `SELECT ${SESSION_COLUMNS} FROM sessions s WHERE s.project_key = $projectKey ORDER BY s.last_event_at DESC LIMIT $limit`,
  ).all({ projectKey, limit })
}
