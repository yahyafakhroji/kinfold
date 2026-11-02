// The TypeScript half of migration v7. SQLite has no hash function,
// so the hash backfill and the collapse of existing duplicate summaries run
// here, inside the same transaction as the v7 SQL (src/store/db.ts): a throw
// rolls both back and user_version stays at 6. Deterministic: prompts are
// hashed in id order, and each duplicate group keeps its earliest summary
// (occurred_at, then id). Only prompt text that has not expired is hashed.

import type { Database } from '../sqlite/types'
import { promptTextHash } from './summary-share'

export interface SummaryMigrationCounts {
  hashed: number
  /** Duplicate summary rows removed; their prompts now point at the kept row. */
  collapsed: number
  groups: number
}

function backfillHashes(db: Database): number {
  const rows = db.query<{ id: number; text: string }, []>('SELECT id, text FROM prompts WHERE text_expired_at IS NULL ORDER BY id').all()
  const update = db.query('UPDATE prompts SET text_hash = $hash WHERE id = $id')
  return rows.reduce((hashed, row) => {
    const hash = promptTextHash(row.text)
    if (hash === null) return hashed
    update.run({ id: row.id, hash })
    return hashed + 1
  }, 0)
}

/** Every summary's own prompt points at it. */
function pointOwners(db: Database): void {
  db.run(`UPDATE prompts SET summary_id = (SELECT m.id FROM summaries m
    WHERE m.session_id = prompts.session_id AND m.prompt_number = prompts.prompt_number)`)
}

/** Summary ids per (project, hash) with more than one row, earliest first. */
function duplicateGroups(db: Database): number[][] {
  return db.query<{ ids: string }, []>(
    `SELECT json_group_array(id) AS ids FROM (
       SELECT DISTINCT s.project_key AS projectKey, p.text_hash AS hash, m.id, m.occurred_at AS at
       FROM prompts p JOIN sessions s ON s.id = p.session_id JOIN summaries m ON m.id = p.summary_id
       WHERE p.text_hash IS NOT NULL ORDER BY projectKey, hash, at, m.id)
     GROUP BY projectKey, hash HAVING count(*) > 1 ORDER BY min(id)`,
  ).all().map((row) => JSON.parse(row.ids) as number[])
}

function collapse(db: Database, keep: number, drop: readonly number[]): void {
  const ids = JSON.stringify(drop)
  db.query('UPDATE prompts SET summary_id = $keep WHERE summary_id IN (SELECT value FROM json_each($ids))').run({ keep, ids })
  db.query("DELETE FROM redaction_findings WHERE table_name = 'summaries' AND row_id IN (SELECT CAST(value AS TEXT) FROM json_each($ids))").run({ ids })
  db.query('DELETE FROM summaries WHERE id IN (SELECT value FROM json_each($ids))').run({ ids })
}

/** Counts from the stored pointers; last_seen_at never before the row's own time. */
function recountAll(db: Database): void {
  db.run(`UPDATE summaries SET
    repeat_count = max(1, (SELECT count(*) FROM prompts p WHERE p.summary_id = summaries.id)),
    last_seen_at = max(occurred_at, coalesce((SELECT max(p.occurred_at) FROM prompts p WHERE p.summary_id = summaries.id), occurred_at))`)
}

export function backfillSummarySharing(db: Database): SummaryMigrationCounts {
  const hashed = backfillHashes(db)
  pointOwners(db)
  const groups = duplicateGroups(db)
  for (const [keep, ...drop] of groups) collapse(db, keep!, drop)
  recountAll(db)
  return { hashed, collapsed: groups.reduce((sum, group) => sum + group.length - 1, 0), groups: groups.length }
}
