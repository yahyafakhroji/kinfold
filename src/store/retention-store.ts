// Text expiry for retention. An event keeps its row and metadata (kind, tool,
// times, hash, redaction notes) and loses its payload to a small JSON marker
// that every payload reader still parses; a prompt keeps its number and loses
// its text (and its text hash). *_expired_at makes a second run a no-op. Batches are bounded so a
// daemon tick never holds the write lock for long.

import { RULES_VERSION } from '../redaction/rules'
import type { Database } from '../sqlite/types'
import { MAX_OBSERVER_ATTEMPTS } from './observer-store'

export const PROMPT_EXPIRED_MARKER = '<expired reason="retention"/>'

/**
 * Events older than the cutoff get the marker once the observer is finished
 * with them: done, or failed with every attempt used. A pending or retryable
 * event keeps its payload however old it is, or a long observer outage would
 * turn its backlog into markers it can never read. The preview counts with
 * the same clause, so it names exactly the rows a run would expire.
 */
const EVENT_EXPIRES = `payload_expired_at IS NULL AND occurred_at < $cutoff
  AND (observer_state = 'done' OR (observer_state = 'failed' AND observer_attempts >= $maxAttempts))`
const PROMPT_EXPIRES = 'text_expired_at IS NULL AND occurred_at < $cutoff'

/** Returns the ids of the events whose payloads became markers. */
export function expireEventPayloads(db: Database, cutoff: number, now: number, limit: number): string[] {
  return db.query<{ id: string }, Record<string, number>>(
    `UPDATE events SET payload = json_object('eventId', event_id, 'kind', kind, 'expired', 'retention', 'expiredAt', $now),
       payload_expired_at = $now, scanned_version = $version
     WHERE rowid IN (SELECT rowid FROM events WHERE ${EVENT_EXPIRES} LIMIT $limit)
     RETURNING event_id AS id`,
  ).all({ cutoff, now, limit, version: RULES_VERSION, maxAttempts: MAX_OBSERVER_ATTEMPTS }).map((row) => row.id)
}

/**
 * Prompts older than the cutoff keep their row and number; returns their ids
 * as text (findings key). The text hash (v7) goes with the text, so an expired
 * prompt matches nothing new; summary_id stays and the shared summary keeps
 * counting it.
 */
export function expirePromptTexts(db: Database, cutoff: number, now: number, limit: number): string[] {
  return db.query<{ id: string }, Record<string, number | string>>(
    `UPDATE prompts SET text = $marker, text_hash = NULL, text_expired_at = $now, scanned_version = $version
     WHERE id IN (SELECT id FROM prompts WHERE ${PROMPT_EXPIRES} LIMIT $limit)
     RETURNING CAST(id AS TEXT) AS id`,
  ).all({ cutoff, now, limit, marker: PROMPT_EXPIRED_MARKER, version: RULES_VERSION }).map((row) => row.id)
}

/** What a retention run would take from one table: rows, and their stored text in characters (as size-store counts it). */
export interface ExpiringRows {
  rows: number
  bytes: number
}

export type ExpiringTable = 'events' | 'prompts' | 'observations' | 'summaries'

/**
 * Purge's expire scope (PurgeTarget 'expire') for the tables retention
 * deletes. A summary ages from its last use (v7 last_seen_at: the newest
 * prompt pointing at it), so a summary still repeated today is not taken
 * because its first prompt is old; a row from before v7 has no last_seen_at
 * and ages from occurred_at. A date-range purge stays on occurred_at ("written
 * in that range"). No index serves the coalesce; summaries has one row per
 * summarized prompt and no occurred_at index either, so both clauses scan it.
 */
export const EXPIRE_WHERE: Readonly<Record<'observations' | 'summaries', string>> = {
  observations: 'occurred_at < $before',
  summaries: 'coalesce(last_seen_at, occurred_at) < $before',
}

/** Per table: the text that goes, and the rows a run picks. Observations and summaries use EXPIRE_WHERE, as purge does. */
const EXPIRING_SQL: Readonly<Record<ExpiringTable, string>> = {
  events: `SELECT count(*) AS rows, coalesce(sum(length(coalesce(payload, ''))), 0) AS bytes FROM events WHERE ${EVENT_EXPIRES}`,
  prompts: `SELECT count(*) AS rows, coalesce(sum(length(text)), 0) AS bytes FROM prompts WHERE ${PROMPT_EXPIRES}`,
  observations: `SELECT count(*) AS rows, coalesce(sum(length(title) + length(narrative) + length(facts) + length(files)), 0) AS bytes
    FROM observations WHERE ${EXPIRE_WHERE.observations}`,
  summaries: `SELECT count(*) AS rows, coalesce(sum(length(coalesce(request, '')) + length(coalesce(learned, '')) + length(coalesce(completed, ''))
    + length(coalesce(next_steps, ''))), 0) AS bytes FROM summaries WHERE ${EXPIRE_WHERE.summaries}`,
}

const PARAMS: Readonly<Record<ExpiringTable, (cutoff: number) => Record<string, number>>> = {
  events: (cutoff) => ({ cutoff, maxAttempts: MAX_OBSERVER_ATTEMPTS }),
  prompts: (cutoff) => ({ cutoff }),
  observations: (before) => ({ before }),
  summaries: (before) => ({ before }),
}

/** Read-only: what a run with this cutoff would expire in one table right now. */
export function countExpiring(db: Database, table: ExpiringTable, cutoff: number): ExpiringRows {
  const params = PARAMS[table](cutoff)
  const row = db.query<ExpiringRows, Record<string, number>>(EXPIRING_SQL[table]).get(params)
  return { rows: row?.rows ?? 0, bytes: row?.bytes ?? 0 }
}

/**
 * MCP read reports (v6) carry ids and counts, no text; they follow the
 * events retention setting, as activity metadata. Deletes up to `limit` rows
 * older than the cutoff and returns how many went.
 */
export function expireMcpReads(db: Database, cutoff: number, limit: number): number {
  return db.query<{ id: number }, Record<string, number>>(
    'DELETE FROM mcp_reads WHERE id IN (SELECT id FROM mcp_reads WHERE occurred_at < $cutoff LIMIT $limit) RETURNING id',
  ).all({ cutoff, limit }).length
}
