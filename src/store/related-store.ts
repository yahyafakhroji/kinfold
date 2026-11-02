// Store side of prompt-time matching: the project's current
// observations that match a prompt's terms (FTS5 BM25, any term), how many of
// those terms each one holds, and rows by id for vector hits. Current only: a
// contradicted or updated observation never comes back as related memory.
// Plain SELECTs, like context-store.ts.

import type { PackObservation } from '../context/types'
import type { Database } from '../sqlite/types'
import { confirmationsColumn, hasLinksTable } from './observation-links'

function columns(db: Database): string {
  const confirmed = hasLinksTable(db) ? confirmationsColumn('o') : '0 AS confirmedBy'
  return `o.id, o.host, o.title, o.evidence, o.contradicted_by AS contradictedBy, NULL AS contradictionKind, o.occurred_at AS occurredAt, ${confirmed}`
}

export interface KeywordQuery {
  projectKey: string
  /** An FTS5 MATCH expression built by ftsMatch(). */
  match: string
  /** Never returned: what this session was already sent. */
  excludeIds: readonly number[]
  /** This session's own rows are left out, as in the delta; null when it has no sessions row yet. */
  excludeSessionId: number | null
  limit: number
}

/** Best BM25 first, then newest id. */
export function keywordCandidates(db: Database, query: KeywordQuery): PackObservation[] {
  return db.query<PackObservation, Record<string, string | number>>(
    `SELECT ${columns(db)} FROM observations_fts f JOIN observations o ON o.id = f.rowid
     WHERE observations_fts MATCH $match AND o.project_key = $projectKey AND o.contradicted_by IS NULL
       AND o.id NOT IN (SELECT value FROM json_each($exclude))
       AND (o.session_id IS NULL OR o.session_id <> $session)
     ORDER BY bm25(observations_fts), o.id DESC LIMIT $limit`,
  ).all({ match: query.match, projectKey: query.projectKey, exclude: JSON.stringify(query.excludeIds), session: query.excludeSessionId ?? -1, limit: query.limit })
}

/** Current observations of the project among `ids`, other sessions' only (null: no exclusion), in no particular order. */
export function currentObservationsByIds(db: Database, projectKey: string, ids: readonly number[], excludeSessionId: number | null = null): PackObservation[] {
  if (ids.length === 0) return []
  return db.query<PackObservation, Record<string, string | number>>(
    `SELECT ${columns(db)} FROM observations o
     WHERE o.id IN (SELECT value FROM json_each($ids)) AND o.project_key = $projectKey AND o.contradicted_by IS NULL
       AND (o.session_id IS NULL OR o.session_id <> $session)`,
  ).all({ ids: JSON.stringify(ids), projectKey, session: excludeSessionId ?? -1 })
}

/**
 * For each id, how many of `matches` (one MATCH expression per prompt term)
 * its title, narrative or facts satisfy. One small query per term, through
 * the same tokenizer as the search, so "matched" means what FTS5 means.
 */
export function matchedTermCounts(db: Database, ids: readonly number[], matches: readonly string[]): Map<number, number> {
  const counts = new Map<number, number>(ids.map((id) => [id, 0]))
  if (ids.length === 0) return counts
  const statement = db.query<{ id: number }, Record<string, string>>(
    'SELECT rowid AS id FROM observations_fts WHERE observations_fts MATCH $match AND rowid IN (SELECT value FROM json_each($ids))',
  )
  const idList = JSON.stringify(ids)
  for (const match of matches) {
    for (const row of statement.all({ match, ids: idList })) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  }
  return counts
}
