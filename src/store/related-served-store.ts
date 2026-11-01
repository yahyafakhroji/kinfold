// Related lines served at prompt time (P2-B labels, schema v9): one row per
// line, with the distance and matched-term count that earned it a place. Ids
// and numbers only, no text. Joined with MCP get_observations reads, they say
// which distances led to a line the agent went on to fetch
// (src/dashboard/hit-rate.ts). A row goes with its observation (foreign key
// cascade) and ages out with the MCP reads (src/data-control/retention.ts).

import type { Database } from '../sqlite/types'

export interface ServedRelated {
  observationId: number
  /** Null when no vector answered for the row. */
  distance: number | null
  matchedTerms: number
}

export interface StoredRelated extends ServedRelated {
  projectKey: string
  host: string
  occurredAt: number
}

export function recordRelatedServed(db: Database, rows: readonly ServedRelated[], at: { projectKey: string; host: string; occurredAt: number }): void {
  if (rows.length === 0) return
  const insert = db.query<unknown, Record<string, string | number | null>>(
    `INSERT INTO related_served (observation_id, project_key, host, distance, matched_terms, occurred_at)
     SELECT $observationId, $projectKey, $host, $distance, $matchedTerms, $occurredAt WHERE EXISTS (SELECT 1 FROM observations WHERE id = $observationId)`,
  )
  db.transaction(() => {
    for (const row of rows) insert.run({ observationId: row.observationId, projectKey: at.projectKey, host: at.host, distance: row.distance, matchedTerms: row.matchedTerms, occurredAt: at.occurredAt })
  })()
}

export function relatedServedSince(db: Database, since: number): StoredRelated[] {
  return db.query<StoredRelated, { since: number }>(
    `SELECT observation_id AS observationId, project_key AS projectKey, host, distance, matched_terms AS matchedTerms, occurred_at AS occurredAt
     FROM related_served WHERE occurred_at >= $since ORDER BY occurred_at`,
  ).all({ since })
}

export function expireRelatedServed(db: Database, cutoff: number, limit: number): number {
  return db.query<{ id: number }, { cutoff: number; limit: number }>(
    'DELETE FROM related_served WHERE id IN (SELECT id FROM related_served WHERE occurred_at < $cutoff LIMIT $limit) RETURNING id',
  ).all({ cutoff, limit }).length
}
