// Row writers for ingest. Each is one statement; the caller owns the
// transaction, so a batch of events commits or rolls back as a unit.

import { RULES_VERSION } from '../redaction/rules'
import type { Database } from '../sqlite/types'
import type { ProjectKey } from './project-key'

export interface SessionInput {
  host: string
  hostSessionId: string
  projectKey: string
  cwd: string
  hostVersion?: string
  occurredAt: number
}

export interface PromptInput {
  sessionId: number
  promptNumber: number
  hostPromptId?: string
  text: string
  occurredAt: number
}

export interface EventRow {
  eventId: string
  sessionId: number
  promptNumber: number | null
  kind: string
  toolName: string | null
  payload: string
  withheld: string | null
  redactions: string
  contentHash: string
  occurredAt: number
  ingestedAt: number
}

export function upsertProject(db: Database, project: ProjectKey, now: number): void {
  db.query(
    `INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ($key, $kind, $displayName, $now)
     ON CONFLICT (key) DO NOTHING`,
  ).run({ key: project.key, kind: project.kind, displayName: project.displayName, now })
}

/** Keyed on (host, host_session_id): the same id under two hosts is two sessions. Returns the session row id. */
export function upsertSession(db: Database, session: SessionInput): number {
  const row = db.query<{ id: number }, Record<string, string | number | null>>(
    `INSERT INTO sessions (host, host_session_id, project_key, cwd, host_version, started_at, last_event_at)
     VALUES ($host, $hostSessionId, $projectKey, $cwd, $hostVersion, $at, $at)
     ON CONFLICT (host, host_session_id) DO UPDATE SET
       started_at = min(started_at, excluded.started_at),
       last_event_at = max(last_event_at, excluded.last_event_at),
       host_version = coalesce(excluded.host_version, host_version)
     RETURNING id`,
  ).get({
    host: session.host,
    hostSessionId: session.hostSessionId,
    projectKey: session.projectKey,
    cwd: session.cwd,
    hostVersion: session.hostVersion ?? null,
    at: session.occurredAt,
  })
  if (row === null) throw new Error('session upsert returned no row')
  return row.id
}

export function markSessionEnded(db: Database, sessionId: number, endedAt: number): void {
  db.query('UPDATE sessions SET ended_at = max(coalesce(ended_at, 0), $endedAt) WHERE id = $sessionId').run({ sessionId, endedAt })
}

export function latestPromptNumber(db: Database, sessionId: number): number {
  const row = db.query<{ n: number }, { sessionId: number }>(
    'SELECT coalesce(max(prompt_number), 0) AS n FROM prompts WHERE session_id = $sessionId',
  ).get({ sessionId })
  return row?.n ?? 0
}

export function promptNumberForHostId(db: Database, sessionId: number, hostPromptId: string): number | null {
  const row = db.query<{ n: number }, { sessionId: number; hostPromptId: string }>(
    `SELECT prompt_number AS n FROM prompts WHERE session_id = $sessionId AND host_prompt_id = $hostPromptId
     ORDER BY prompt_number DESC LIMIT 1`,
  ).get({ sessionId, hostPromptId })
  return row?.n ?? null
}

/** Prompt text passed the edge rules of this build, so it is stored as redacted and scanned under RULES_VERSION. */
export function insertPrompt(db: Database, prompt: PromptInput): void {
  db.query(
    `INSERT INTO prompts (session_id, prompt_number, host_prompt_id, text, occurred_at, rules_version, scanned_version)
     VALUES ($sessionId, $promptNumber, $hostPromptId, $text, $occurredAt, $rulesVersion, $rulesVersion)`,
  ).run({ ...prompt, hostPromptId: prompt.hostPromptId ?? null, rulesVersion: RULES_VERSION })
}

export function eventExists(db: Database, eventId: string): boolean {
  return db.query('SELECT 1 FROM events WHERE event_id = $eventId').get({ eventId }) !== null
}

/** INSERT OR IGNORE: a retried spool entry carries the same event_id and adds nothing. Returns true when a row was added. */
export function insertEvent(db: Database, row: EventRow): boolean {
  const result = db.query(
    `INSERT OR IGNORE INTO events
       (event_id, session_id, prompt_number, kind, tool_name, payload, withheld, redactions, content_hash, occurred_at, ingested_at,
        rules_version, scanned_version)
     VALUES ($eventId, $sessionId, $promptNumber, $kind, $toolName, $payload, $withheld, $redactions, $contentHash, $occurredAt, $ingestedAt,
        $rulesVersion, $rulesVersion)`,
  ).run({ ...row, rulesVersion: RULES_VERSION })
  return result.changes > 0
}
