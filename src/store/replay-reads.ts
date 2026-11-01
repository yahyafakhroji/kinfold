// Read-only input for the scheduler replay (src/daemon/replay.ts): the event
// timeline without payloads, and the stored durations of succeeded observer
// runs per host. Timestamps and kinds only, so a replay never sees content.

import type { Database } from '../sqlite/types'

export interface TimelineEvent {
  eventId: string
  sessionId: number
  host: string
  kind: string
  promptNumber: number | null
  occurredAt: number
  ingestedAt: number
}

/** Every stored event in ingest order, the order the daemon saw them. */
export function eventTimeline(db: Database): TimelineEvent[] {
  return db.query<TimelineEvent, []>(
    `SELECT e.event_id AS eventId, e.session_id AS sessionId, s.host, e.kind, e.prompt_number AS promptNumber,
            e.occurred_at AS occurredAt, e.ingested_at AS ingestedAt
     FROM events e JOIN sessions s ON s.id = e.session_id
     ORDER BY e.ingested_at, e.occurred_at, e.event_id`,
  ).all()
}

/** host -> finished_at - started_at of its succeeded runs, oldest first. */
export function runDurations(db: Database): Map<string, number[]> {
  const rows = db.query<{ host: string; ms: number }, []>(
    `SELECT host, finished_at - started_at AS ms FROM observer_runs
     WHERE status = 'succeeded' AND finished_at IS NOT NULL ORDER BY id`,
  ).all()
  const hosts = [...new Set(rows.map((row) => row.host))]
  return new Map(hosts.map((host) => [host, rows.filter((row) => row.host === host).map((row) => row.ms)]))
}
