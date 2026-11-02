// Read-only queries behind the latency part of GET /metrics/summary.
// Capture-to-searchable lag is split into the stages the stored timestamps
// can tell apart, for every event an observation cites:
//   ingest    events.ingested_at - events.occurred_at (spool and drain)
//   scheduler observer_runs.started_at - events.ingested_at (waiting for a batch)
//   run       observer_runs.finished_at - started_at (the model call)
//   write     observations.created_at - observer_runs.finished_at
// An observation's run is the succeeded run of its session that finished at
// its created_at: the writer stamps both with the same clock reading, so the
// write stage reads 0 today and is kept to catch a future split. A turn's lag
// is measured from its turn_end to the first succeeded run of the session that
// started after that turn_end was ingested (runs take events oldest first).
// Percentiles and grouping are pure functions in src/dashboard/metrics.ts.

import type { Database } from '../sqlite/types'
import { METRICS_SAMPLE_LIMIT } from './metrics-reads'

export interface EventStageRow {
  host: string
  provider: string
  ingestMs: number
  schedulerMs: number
  runMs: number
  writeMs: number
  /** created_at - occurred_at: the sum of the four stages. */
  lagMs: number
}

export interface TurnLagRow {
  host: string
  provider: string
  /** First searchable moment after the turn ended, minus the turn_end's occurred_at. */
  lagMs: number
}

/**
 * One row per cited event, from the first observation that cites it, for
 * observations created at or after `since`. Newest observations first.
 */
export function eventStages(db: Database, since: number, limit: number = METRICS_SAMPLE_LIMIT): EventStageRow[] {
  return db.query<EventStageRow, { since: number; limit: number }>(
    `WITH recent AS (
       SELECT id, session_id, created_at, source_event_ids FROM observations
       WHERE created_at >= $since ORDER BY id DESC LIMIT $limit
     ), cited AS (
       SELECT j.value AS event_id, min(o.created_at) AS created_at, o.session_id
       FROM recent o JOIN json_each(o.source_event_ids) j GROUP BY j.value
     )
     SELECT r.host, r.provider,
            e.ingested_at - e.occurred_at AS ingestMs,
            r.started_at - e.ingested_at AS schedulerMs,
            r.finished_at - r.started_at AS runMs,
            c.created_at - r.finished_at AS writeMs,
            c.created_at - e.occurred_at AS lagMs
     FROM cited c
     JOIN events e ON e.event_id = c.event_id
     JOIN observer_runs r ON r.id = (
       SELECT id FROM observer_runs WHERE session_id = c.session_id AND status = 'succeeded'
         AND finished_at = c.created_at ORDER BY id LIMIT 1)`,
  ).all({ since, limit })
}

/** One row per turn_end that occurred at or after `since` and has been observed. */
export function turnLags(db: Database, since: number, limit: number = METRICS_SAMPLE_LIMIT): TurnLagRow[] {
  return db.query<TurnLagRow, { since: number; limit: number }>(
    `SELECT r.host, r.provider, r.finished_at - t.occurred_at AS lagMs
     FROM (SELECT session_id, occurred_at, ingested_at FROM events
           WHERE kind = 'turn_end' AND occurred_at >= $since ORDER BY occurred_at DESC LIMIT $limit) t
     JOIN observer_runs r ON r.id = (
       SELECT id FROM observer_runs WHERE session_id = t.session_id AND status = 'succeeded'
         AND started_at >= t.ingested_at ORDER BY started_at, id LIMIT 1)`,
  ).all({ since, limit })
}
