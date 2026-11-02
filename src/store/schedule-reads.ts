// One read the observer scheduler needs beyond queueStats: when each
// session's oldest pending event was ingested, so a long turn's early events
// can start a batch once they have waited long enough. Pending only:
// a failed event waits for its own retry time, not for this rule.

import type { Database } from '../sqlite/types'

/** sessionId -> min(ingested_at) over its pending events. Uses the events_pending index. */
export function oldestPendingIngest(db: Database): Map<number, number> {
  const rows = db.query<{ sessionId: number; at: number }, []>(
    `SELECT session_id AS sessionId, min(ingested_at) AS at FROM events
     WHERE observer_state = 'pending' GROUP BY session_id`,
  ).all()
  return new Map(rows.map((row) => [row.sessionId, row.at]))
}
