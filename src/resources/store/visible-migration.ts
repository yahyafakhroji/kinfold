// The TypeScript half of migration v12, in the same transaction as its SQL
// (src/resources/store/db.ts). The agent's reply used to live only in a turn_end event's
// payload, under the shorter events retention; this copies every reply still
// readable there next to its prompt. A payload retention already replaced has
// no reply to copy, and one that is not JSON is skipped rather than failing
// the migration. Stop can fire several times for one prompt, so events are
// read oldest first and the latest reply wins, as ingest does from here on.

import type { Database } from '../sqlite/types'

/** Events read per page of the backfill. */
export const BACKFILL_PAGE = 500

interface TurnEnd {
  sessionId: number
  promptNumber: number
  payload: string
}

function replyOf(payload: string): string | null {
  try {
    const value: unknown = JSON.parse(payload)
    if (typeof value !== 'object' || value === null) return null
    const text = (value as { assistantText?: unknown }).assistantText
    return typeof text === 'string' && text !== '' ? text : null
  } catch {
    return null
  }
}

/** Returns how many prompts got a reply. Also dates the impact numbers, which start with this version. */
export function backfillReplies(db: Database, now: number = Date.now()): number {
  // Read a page at a time: a store that keeps events forever holds every reply it ever captured, and all of them at once would not fit in memory.
  const page = db.query<TurnEnd & { at: number; row: number }, { at: number; row: number; limit: number }>(
    `SELECT session_id AS sessionId, prompt_number AS promptNumber, payload, occurred_at AS at, rowid AS row FROM events
     WHERE kind = 'turn_end' AND prompt_number IS NOT NULL AND payload IS NOT NULL AND payload_expired_at IS NULL
       AND (occurred_at > $at OR (occurred_at = $at AND rowid > $row))
     ORDER BY occurred_at, rowid LIMIT $limit`,
  )
  const update = db.query('UPDATE prompts SET reply_text = $reply WHERE session_id = $sessionId AND prompt_number = $promptNumber AND text_expired_at IS NULL')
  const filled = new Set<string>()
  let cursor = { at: -1, row: -1 }
  for (;;) {
    const rows = page.all({ ...cursor, limit: BACKFILL_PAGE })
    for (const row of rows) {
      const reply = replyOf(row.payload)
      if (reply === null) continue
      if (update.run({ reply, sessionId: row.sessionId, promptNumber: row.promptNumber }).changes > 0) filled.add(`${row.sessionId}:${row.promptNumber}`)
    }
    const last = rows.at(-1)
    if (last === undefined || rows.length < BACKFILL_PAGE) break
    cursor = { at: last.at, row: last.row }
  }
  db.query("UPDATE data_settings SET value = $now WHERE key = 'impact.since' AND value IS NULL").run({ now })
  return filled.size
}
