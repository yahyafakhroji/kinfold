// Shared summaries for identical prompts. A prompt whose stored text
// (already redacted) matches, after trimming and collapsing whitespace, a
// prompt of the same project that already has a summary points at that
// summary instead of adding a row. Identity is a sha256 of the normalized
// text kept in prompts.text_hash; text is only ever compared through it.
// Window: the whole project, no time limit. A coordinator notification can
// repeat for days, and an identical request asks the same thing whenever it
// comes; retention and purge bound how far back a match can reach.
//
// Ownership: a summary row keeps the (session, prompt) of the first prompt
// that wrote it, and every prompt that uses it (the first one included)
// carries its id in prompts.summary_id. repeat_count and last_seen_at are
// recounted from those pointers, so a purge can never leave them stale.

import { createHash } from 'node:crypto'
import type { ObserverEvent, ParsedSummary } from '../observer/types'
import type { Database } from '../sqlite/types'
import { upsertSummary } from './observer-store'

export type SummaryWrite = 'own' | 'shared' | 'none'

export interface SharedSummaryInput {
  sessionId: number
  projectKey: string
  promptNumber: number
  /** Null when the observer returned none; a repeat still attaches to the shared row. */
  summary: ParsedSummary | null
  occurredAt: number
  now: number
}

interface PromptRef {
  id: number
  text: string
  textHash: string | null
  expired: number
  summaryId: number | null
}

export function normalizePromptText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** Null for text that normalizes to nothing: an empty prompt repeats nothing. */
export function promptTextHash(text: string): string | null {
  const normalized = normalizePromptText(text)
  return normalized === '' ? null : createHash('sha256').update(normalized).digest('hex')
}

function promptRef(db: Database, sessionId: number, promptNumber: number): PromptRef | null {
  return db.query<PromptRef, { sessionId: number; promptNumber: number }>(
    `SELECT id, text, text_hash AS textHash, text_expired_at IS NOT NULL AS expired, summary_id AS summaryId
     FROM prompts WHERE session_id = $sessionId AND prompt_number = $promptNumber`,
  ).get({ sessionId, promptNumber })
}

/** An expired prompt holds the retention marker, which must never match another expired prompt. */
function hashOf(prompt: PromptRef): string | null {
  if (prompt.expired === 1) return null
  return prompt.textHash ?? promptTextHash(prompt.text)
}

/** The earliest summary another prompt of the project with this hash uses; null when none. */
export function sharedSummaryFor(db: Database, projectKey: string, textHash: string, promptId: number): number | null {
  return db.query<{ id: number | null }, Record<string, string | number>>(
    `SELECT min(p.summary_id) AS id FROM prompts p JOIN sessions s ON s.id = p.session_id
     WHERE p.text_hash = $textHash AND s.project_key = $projectKey AND p.summary_id IS NOT NULL AND p.id <> $promptId`,
  ).get({ textHash, projectKey, promptId })?.id ?? null
}

function ownSummaryId(db: Database, sessionId: number, promptNumber: number): number | null {
  return db.query<{ id: number }, { sessionId: number; promptNumber: number }>(
    'SELECT id FROM summaries WHERE session_id = $sessionId AND prompt_number = $promptNumber',
  ).get({ sessionId, promptNumber })?.id ?? null
}

function point(db: Database, promptId: number, summaryId: number, textHash: string | null): void {
  db.query('UPDATE prompts SET summary_id = $summaryId, text_hash = coalesce(text_hash, $textHash) WHERE id = $promptId')
    .run({ promptId, summaryId, textHash })
}

/** repeat_count is how many prompts use the row (at least 1); last_seen_at the latest of them, never before the row itself. */
export function recountSummaries(db: Database, ids: readonly number[]): void {
  if (ids.length === 0) return
  db.query(
    `UPDATE summaries SET
       repeat_count = max(1, (SELECT count(*) FROM prompts p WHERE p.summary_id = summaries.id)),
       last_seen_at = max(occurred_at, coalesce((SELECT max(p.occurred_at) FROM prompts p WHERE p.summary_id = summaries.id), occurred_at))
     WHERE id IN (SELECT value FROM json_each($ids))`,
  ).run({ ids: JSON.stringify([...new Set(ids)]) })
}

function writeOwn(db: Database, input: SharedSummaryInput, prompt: PromptRef | null, textHash: string | null): SummaryWrite {
  if (input.summary === null) return 'none'
  upsertSummary(db, { sessionId: input.sessionId, promptNumber: input.promptNumber, ...input.summary, occurredAt: input.occurredAt, updatedAt: input.now })
  const id = ownSummaryId(db, input.sessionId, input.promptNumber)
  if (id === null) throw new Error('summary upsert left no row')
  if (prompt !== null) point(db, prompt.id, id, textHash)
  recountSummaries(db, [id])
  return 'own'
}

/**
 * The summary write for one prompt. Its own row (a re-run of the same turn)
 * takes the upsert as before. Otherwise a repeat of a summarized prompt
 * points at that summary, whose text stays as the first prompt wrote it,
 * and the new text, if any, is dropped. Anything else writes its own row.
 */
export function writeSharedSummary(db: Database, input: SharedSummaryInput): SummaryWrite {
  const prompt = promptRef(db, input.sessionId, input.promptNumber)
  const textHash = prompt === null ? null : hashOf(prompt)
  if (ownSummaryId(db, input.sessionId, input.promptNumber) !== null || prompt === null || textHash === null) {
    return writeOwn(db, input, prompt, textHash)
  }
  const shared = sharedSummaryFor(db, input.projectKey, textHash, prompt.id)
  if (shared === null) return writeOwn(db, input, prompt, textHash)
  const previous = prompt.summaryId
  point(db, prompt.id, shared, textHash)
  recountSummaries(db, previous === null || previous === shared ? [shared] : [shared, previous])
  return 'shared'
}

/**
 * Read-only, before the observer call: the batch's prompt numbers whose text
 * repeats a prompt of the project that already has a summary, and that have
 * no summary of their own yet. The prompt tells the observer it may return
 * summary null for them; one indexed lookup per prompt, no model call.
 */
export function repeatedPromptNumbers(db: Database, sessionId: number, projectKey: string, events: readonly Pick<ObserverEvent, 'promptNumber'>[]): number[] {
  const numbers = [...new Set(events.map((event) => event.promptNumber).filter((n): n is number => n !== null))].sort((a, b) => a - b)
  return numbers.filter((promptNumber) => {
    const prompt = promptRef(db, sessionId, promptNumber)
    if (prompt === null || ownSummaryId(db, sessionId, promptNumber) !== null) return false
    const textHash = hashOf(prompt)
    return textHash !== null && sharedSummaryFor(db, projectKey, textHash, prompt.id) !== null
  })
}
