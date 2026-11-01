// Store side of the observer. Events move pending -> processing -> done, or to
// failed with an attempt count and a retry time; after MAX_OBSERVER_ATTEMPTS
// a failed event stays failed and visible. Every statement here is single and
// synchronous, so the caller can group them in one transaction.

import type { ObserverEvent } from '../observer/types'
import { RULES_VERSION } from '../redaction/rules'
import type { Database } from '../sqlite/types'

export const MAX_OBSERVER_ATTEMPTS = 3
/** Retry delay doubles per failed attempt: 30 s, then 60 s. */
export const RETRY_BASE_MS = 30_000

export interface ObserverSession {
  id: number
  host: string
  projectKey: string
  endedAt: number | null
  lastEventAt: number
}

export interface QueueStats {
  sessionId: number
  retryable: number
  /** A retryable turn_end or session_end is waiting: the turn is over, observe it now. */
  hasBoundary: boolean
  lastEventAt: number
  endedAt: number | null
}

export interface RunStart {
  sessionId: number
  host: string
  provider: string
  model: string
  eventCount: number
  startedAt: number
}

export interface ObservationRow {
  projectKey: string
  sessionId: number
  host: string
  promptNumber: number | null
  type: string
  title: string
  narrative: string
  facts: string
  files: string
  evidence: string
  sourceEventIds: string
  observerModel: string
  contentHash: string
  occurredAt: number
  createdAt: number
}

export interface SummaryRow {
  sessionId: number
  promptNumber: number
  request: string
  learned: string
  completed: string
  nextSteps: string
  occurredAt: number
  updatedAt: number
}

const RETRYABLE = `(e.observer_state = 'pending'
  OR (e.observer_state = 'failed' AND e.observer_attempts < $maxAttempts AND coalesce(e.observer_retry_at, 0) <= $now))`

export function getObserverSession(db: Database, sessionId: number): ObserverSession | null {
  return db.query<ObserverSession, { sessionId: number }>(
    `SELECT id, host, project_key AS projectKey, ended_at AS endedAt, last_event_at AS lastEventAt
     FROM sessions WHERE id = $sessionId`,
  ).get({ sessionId })
}

/** Oldest first, so a batch reads as the session happened. */
export function retryableEvents(db: Database, sessionId: number, now: number, limit: number): ObserverEvent[] {
  return db.query<ObserverEvent, Record<string, number>>(
    `SELECT e.event_id AS eventId, e.session_id AS sessionId, e.prompt_number AS promptNumber, e.kind,
            e.tool_name AS toolName, coalesce(e.payload, '{}') AS payload, e.withheld, e.occurred_at AS occurredAt
     FROM events e WHERE e.session_id = $sessionId AND ${RETRYABLE}
     ORDER BY e.occurred_at, e.event_id LIMIT $limit`,
  ).all({ sessionId, now, limit, maxAttempts: MAX_OBSERVER_ATTEMPTS })
}

export function queueStats(db: Database, now: number): QueueStats[] {
  return db.query<Omit<QueueStats, 'hasBoundary'> & { hasBoundary: number }, Record<string, number>>(
    `SELECT s.id AS sessionId, count(*) AS retryable,
            max(e.kind IN ('turn_end', 'session_end')) AS hasBoundary,
            s.last_event_at AS lastEventAt, s.ended_at AS endedAt
     FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE ${RETRYABLE}
     GROUP BY s.id ORDER BY min(e.occurred_at)`,
  ).all({ now, maxAttempts: MAX_OBSERVER_ATTEMPTS }).map((row) => ({ ...row, hasBoundary: row.hasBoundary === 1 }))
}

function setStates(db: Database, eventIds: readonly string[], sql: string, params: Record<string, number> = {}): void {
  const statement = db.query(sql)
  for (const eventId of eventIds) statement.run({ ...params, eventId })
}

export function markProcessing(db: Database, eventIds: readonly string[]): void {
  setStates(db, eventIds, "UPDATE events SET observer_state = 'processing' WHERE event_id = $eventId")
}

export function markDone(db: Database, eventIds: readonly string[]): void {
  setStates(db, eventIds, "UPDATE events SET observer_state = 'done', observer_retry_at = NULL WHERE event_id = $eventId")
}

/** One more attempt counted; the retry time doubles with each failure. */
export function markFailed(db: Database, eventIds: readonly string[], now: number): void {
  setStates(
    db,
    eventIds,
    `UPDATE events SET observer_state = 'failed', observer_attempts = observer_attempts + 1,
       observer_retry_at = $now + $baseMs * (1 << observer_attempts)
     WHERE event_id = $eventId`,
    { now, baseMs: RETRY_BASE_MS },
  )
}

export function startRun(db: Database, run: RunStart): number {
  const row = db.query<{ id: number }, Record<string, string | number>>(
    `INSERT INTO observer_runs (session_id, host, provider, model, status, event_count, started_at)
     VALUES ($sessionId, $host, $provider, $model, 'running', $eventCount, $startedAt) RETURNING id`,
  ).get({ ...run })
  if (row === null) throw new Error('observer run insert returned no row')
  return row.id
}

export function finishRun(db: Database, runId: number, status: 'succeeded' | 'failed', error: string | null, finishedAt: number, model?: string): void {
  db.query(
    `UPDATE observer_runs SET status = $status, error = $error, finished_at = $finishedAt, model = coalesce($model, model)
     WHERE id = $runId`,
  ).run({ runId, status, error, finishedAt, model: model ?? null })
}

/** Dedupe on (project_key, content_hash): the same observation from a retried batch adds nothing. */
export function insertObservation(db: Database, row: ObservationRow): boolean {
  const result = db.query(
    `INSERT INTO observations (project_key, session_id, host, prompt_number, type, title, narrative, facts, files, evidence,
       source_event_ids, observer_model, content_hash, occurred_at, created_at, rules_version, scanned_version)
     SELECT $projectKey, $sessionId, $host, $promptNumber, $type, $title, $narrative, $facts, $files, $evidence,
       $sourceEventIds, $observerModel, $contentHash, $occurredAt, $createdAt, $rulesVersion, 0
     WHERE NOT EXISTS (SELECT 1 FROM observations WHERE project_key = $projectKey AND content_hash = $contentHash)`,
  ).run({ ...row, rulesVersion: RULES_VERSION })
  return result.changes > 0
}

/** A field that comes back empty (or blank) keeps what an earlier revision stored. */
const KEEP_IF_EMPTY = (column: string): string => `${column} = coalesce(nullif(trim(excluded.${column}), ''), ${column})`

/**
 * One row per (session, prompt); Stop firing twice, or a later batch of the
 * same turn, bumps revision and updated_at instead of adding a duplicate. A
 * non-empty field replaces the stored one; an empty one never does, so a
 * batch that saw only the tail of a turn cannot blank out its request.
 */
export function upsertSummary(db: Database, row: SummaryRow): void {
  db.query(
    `INSERT INTO summaries (session_id, prompt_number, request, learned, completed, next_steps, revision, occurred_at, updated_at,
       rules_version, scanned_version)
     VALUES ($sessionId, $promptNumber, $request, $learned, $completed, $nextSteps, 1, $occurredAt, $updatedAt, $rulesVersion, 0)
     ON CONFLICT (session_id, prompt_number) DO UPDATE SET
       ${['request', 'learned', 'completed', 'next_steps'].map(KEEP_IF_EMPTY).join(', ')}, revision = revision + 1,
       occurred_at = max(occurred_at, excluded.occurred_at), updated_at = excluded.updated_at,
       rules_version = excluded.rules_version, scanned_version = 0`,
  ).run({ ...row, rulesVersion: RULES_VERSION })
}

/** Sessions silent since `cutoff` with no ended_at get one at their last event (OpenCode never sends session_end on quit). */
export function endIdleSessions(db: Database, cutoff: number): number[] {
  return db.query<{ id: number }, { cutoff: number }>(
    'UPDATE sessions SET ended_at = last_event_at WHERE ended_at IS NULL AND last_event_at <= $cutoff RETURNING id',
  ).all({ cutoff }).map((row) => row.id)
}

/** After a crash: claimed events go back to pending and the open run is closed as interrupted. */
export function recoverInterrupted(db: Database, now: number): { events: number; runs: number } {
  return db.transaction(() => {
    const events = db.run("UPDATE events SET observer_state = 'pending' WHERE observer_state = 'processing'").changes
    const runs = db.query(
      "UPDATE observer_runs SET status = 'failed', error = 'interrupted: daemon stopped mid-run', finished_at = $now WHERE status = 'running'",
    ).run({ now }).changes
    return { events, runs }
  })()
}
