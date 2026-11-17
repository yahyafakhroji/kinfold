// Store side of context delivery. Packs are precomputed rows keyed
// (project_key, host_profile), so serving one is a single indexed read; every
// pack served leaves an injections row (the audit log and hit-rate source).
// Reads here are plain SELECTs, so the read-only fallback can share them.

import type { FirstScreen } from '../context/recall-line'
import type { ContextChannel, HostProfile, PackObservation } from '../context/types'
import type { Database } from '../sqlite/types'
import { confirmationsColumn, contradictionKindColumn, hasLinksTable } from './observation-links'

export interface PackRow {
  projectKey: string
  hostProfile: HostProfile
  body: string
  tokenCount: number
  observationIds: number[]
  builtFromMaxId: number
  builtAt: number
}

export interface InjectionRow {
  /** Null when the host session has no sessions row yet; host_session_id still names it. */
  sessionId: number | null
  host: string
  hostSessionId: string
  projectKey: string
  observationIds: readonly number[]
  channel: ContextChannel
  tokens: number
  occurredAt: number
  /** Time to build or match what was served (v6); null or absent when not measured. */
  durationMs?: number | null
  /** Prompt channel (v12): the session's latest prompt at this moment, or null when none is stored yet; ingest corrects it (stampInjectionPrompts). */
  promptNumber?: number | null
  /** Recall was skipped for the impact test (v12); such a row carries no ids. */
  heldOut?: boolean
  /** The answer came after the host stopped waiting (v13): recorded so it can be shown, but not as delivered. */
  late?: boolean
  /** How many of the ids are related memory (v12); they are the last ones. */
  relatedCount?: number
}

interface StoredPack {
  body: string
  tokenCount: number
  observationIds: string
  builtFromMaxId: number
  builtAt: number
}

function parseIds(json: string): number[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)) : []
  } catch {
    // A pack row this build did not write: serve its text without ids rather than fail the read.
    return []
  }
}

export function readPack(db: Database, projectKey: string, hostProfile: HostProfile): PackRow | null {
  const row = db.query<StoredPack, { projectKey: string; hostProfile: string }>(
    `SELECT body, token_count AS tokenCount, observation_ids AS observationIds, built_from_max_id AS builtFromMaxId, built_at AS builtAt
     FROM context_packs WHERE project_key = $projectKey AND host_profile = $hostProfile`,
  ).get({ projectKey, hostProfile })
  return row === null ? null : { ...row, projectKey, hostProfile, observationIds: parseIds(row.observationIds) }
}

export function upsertPack(db: Database, pack: PackRow): void {
  db.query(
    `INSERT INTO context_packs (project_key, host_profile, body, token_count, observation_ids, built_from_max_id, built_at)
     VALUES ($projectKey, $hostProfile, $body, $tokenCount, $observationIds, $builtFromMaxId, $builtAt)
     ON CONFLICT (project_key, host_profile) DO UPDATE SET
       body = excluded.body, token_count = excluded.token_count, observation_ids = excluded.observation_ids,
       built_from_max_id = excluded.built_from_max_id, built_at = excluded.built_at`,
  ).run({ ...pack, observationIds: JSON.stringify(pack.observationIds) })
}

/** Null for a project the daemon has never ingested. */
export function projectDisplayName(db: Database, projectKey: string): string | null {
  const row = db.query<{ name: string }, { projectKey: string }>('SELECT display_name AS name FROM projects WHERE key = $projectKey')
    .get({ projectKey })
  return row?.name ?? null
}

/** 0 when the project has no observations yet. */
export function maxObservationId(db: Database, projectKey: string): number {
  const row = db.query<{ id: number }, { projectKey: string }>(
    'SELECT coalesce(max(id), 0) AS id FROM observations WHERE project_key = $projectKey',
  ).get({ projectKey })
  return row?.id ?? 0
}

/** All hosts, newest first. Titles only: narratives reach a host through MCP on demand. */
export function packObservations(db: Database, projectKey: string, limit: number): PackObservation[] {
  return db.query<PackObservation, { projectKey: string; limit: number }>(
    `SELECT o.id, o.host, o.title, o.evidence, o.contradicted_by AS contradictedBy, ${contradictionKindColumn('o')}, o.occurred_at AS occurredAt,
       ${confirmationsColumn('o')}
     FROM observations o WHERE o.project_key = $projectKey ORDER BY o.occurred_at DESC, o.id DESC LIMIT $limit`,
  ).all({ projectKey, limit })
}

export interface LatestNextSteps {
  text: string
  /** How many prompts share the summary (v7); 1 for a summary of its own. */
  repeatCount: number
}

/**
 * next_steps of the project's most recent summary that has any. A shared
 * summary is one row, dated by its first prompt, so a prompt repeated all
 * day does not keep its summary on top.
 */
export function latestNextSteps(db: Database, projectKey: string): LatestNextSteps | null {
  return db.query<LatestNextSteps, { projectKey: string }>(
    `SELECT m.next_steps AS text, m.repeat_count AS repeatCount FROM summaries m JOIN sessions s ON s.id = m.session_id
     WHERE s.project_key = $projectKey AND coalesce(trim(m.next_steps), '') <> ''
     ORDER BY m.occurred_at DESC, m.id DESC LIMIT 1`,
  ).get({ projectKey })
}

export function sessionIdFor(db: Database, host: string, hostSessionId: string): number | null {
  const row = db.query<{ id: number }, { host: string; hostSessionId: string }>(
    'SELECT id FROM sessions WHERE host = $host AND host_session_id = $hostSessionId',
  ).get({ host, hostSessionId })
  return row?.id ?? null
}

export function recordInjection(db: Database, injection: InjectionRow): number {
  const row = db.query<{ id: number }, Record<string, string | number | null>>(
    `INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at, duration_ms,
       prompt_number, held_out, related_count, late)
     VALUES ($sessionId, $host, $hostSessionId, $projectKey, $observationIds, $channel, $tokens, $occurredAt, $durationMs,
       $promptNumber, $heldOut, $relatedCount, $late) RETURNING id`,
  ).get({
    sessionId: injection.sessionId, host: injection.host, hostSessionId: injection.hostSessionId, projectKey: injection.projectKey,
    observationIds: JSON.stringify(injection.observationIds), channel: injection.channel, tokens: injection.tokens, occurredAt: injection.occurredAt,
    durationMs: injection.durationMs ?? null, promptNumber: injection.promptNumber ?? null, heldOut: injection.heldOut === true ? 1 : 0,
    relatedCount: injection.relatedCount ?? 0, late: injection.late === true ? 1 : 0,
  })
  if (row === null) throw new Error('injection insert returned no row')
  return row.id
}

/** The session's newest prompt at or before `at`; null when none is stored (the hook asks before its prompt is ingested). */
export function promptNumberAt(db: Database, host: string, hostSessionId: string, at: number): number | null {
  const row = db.query<{ n: number | null }, { host: string; hostSessionId: string; at: number }>(
    `SELECT max(p.prompt_number) AS n FROM prompts p JOIN sessions s ON s.id = p.session_id
     WHERE s.host = $host AND s.host_session_id = $hostSessionId AND p.occurred_at <= $at`,
  ).get({ host, hostSessionId, at })
  return row?.n ?? null
}

export interface PromptStamp {
  sessionId: number
  host: string
  hostSessionId: string
  promptNumber: number
  /** The prompt's own event time. */
  occurredAt: number
}

/**
 * Run when a prompt is ingested. The hook asks for recall right after it
 * spools the prompt, so the injection is often written first, with no prompt
 * to name or with the one before. Every prompt-time row of the session from
 * this prompt's time on belongs to it, until a later prompt claims its own.
 */
export function stampInjectionPrompts(db: Database, stamp: PromptStamp): number {
  return db.query(
    `UPDATE injections SET prompt_number = $promptNumber, session_id = coalesce(session_id, $sessionId)
     WHERE host = $host AND host_session_id = $hostSessionId AND channel = 'prompt' AND occurred_at >= $occurredAt
       AND (prompt_number IS NULL OR prompt_number < $promptNumber)`,
  ).run({ ...stamp }).changes
}

// --- What the user is shown about an answer: titles and a header for ids it already carries. ---

/** Ids per statement; a pack holds about 80. */
const TITLE_CHUNK = 200

/** Title by id for the ids that still exist. */
export function titlesFor(db: Database, ids: readonly number[]): Map<number, string> {
  const titles = new Map<number, string>()
  for (let start = 0; start < ids.length; start += TITLE_CHUNK) {
    const chunk = ids.slice(start, start + TITLE_CHUNK)
    const rows = db.query<{ id: number; title: string }, number[]>(`SELECT id, title FROM observations WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)
    for (const row of rows) titles.set(row.id, row.title)
  }
  return titles
}

export interface FirstScreenQuery {
  projectKey: string
  host: string
  hostSessionId: string
  /** The pack's ids: rows come from these alone. */
  ids: readonly number[]
  rows: number
}

/** The session-start list's header and the newest `rows` of the pack; null for a project the store has never seen. */
export function firstScreenFor(db: Database, query: FirstScreenQuery): FirstScreen | null {
  const project = projectDisplayName(db, query.projectKey)
  if (project === null) return null
  const total = db.query<{ n: number }, { projectKey: string }>('SELECT count(*) AS n FROM observations WHERE project_key = $projectKey').get({ projectKey: query.projectKey })?.n ?? 0
  const last = db.query<{ at: number | null }, { projectKey: string; host: string; hostSessionId: string }>(
    `SELECT max(last_event_at) AS at FROM sessions
     WHERE project_key = $projectKey AND NOT (host = $host AND host_session_id = $hostSessionId)`,
  ).get({ projectKey: query.projectKey, host: query.host, hostSessionId: query.hostSessionId })
  const ids = query.ids.slice(0, TITLE_CHUNK)
  const rows = ids.length === 0 ? [] : db.query<{ id: number; title: string; occurredAt: number }, number[]>(
    `SELECT id, title, occurred_at AS occurredAt FROM observations WHERE id IN (${ids.map(() => '?').join(',')})
     ORDER BY occurred_at DESC, id DESC LIMIT ${Math.max(0, Math.floor(query.rows))}`,
  ).all(...ids)
  return { project, total, lastSessionAt: last?.at ?? null, rows }
}

// --- Prompt-time deltas. Plain SELECTs, so the read-only fallback shares them. ---

/** What a host session has been handed so far, from its injections rows. */
export interface SessionDeliveries {
  /** Every observation id any injection for this host session carried. */
  sentIds: number[]
  /** When the session first received memory; null when it never did. */
  firstAt: number | null
}

/** Per connection: a schema does not lose a column while it is open, and this runs on every prompt. */
const lateColumn = new WeakMap<Database, boolean>()

function hasLateColumn(db: Database): boolean {
  const known = lateColumn.get(db)
  if (known !== undefined) return known
  const found = db.query<{ name: string }, []>('PRAGMA table_info(injections)').all().some((row) => row.name === 'late')
  // Only a yes is kept: a store from before v13 can be migrated under the same connection.
  if (found) lateColumn.set(db, true)
  return found
}

/** Late answers that may carry one id before it counts as delivered: the first is offered again, the second is not. */
export const LATE_OFFERS_BEFORE_DELIVERED = 2

export function sessionDeliveries(db: Database, host: string, hostSessionId: string): SessionDeliveries {
  // A held-out prompt leaves a prompt-channel row with no ids, the only row of that shape (any other
  // empty answer records nothing). It delivered nothing, so it must not become the moment the session
  // "first received memory": the delta would then skip what was written before it. Told apart by shape
  // rather than by held_out, so the read-only fallback can run this on a store from before v12.
  // A late answer was probably never shown, so its ids are offered again with the next prompt. An id in
  // two late answers counts as sent: when every answer of a session comes late, the same memory would
  // otherwise ride on every prompt and never get through. Late rows never set firstAt.
  // The read-only fallback can meet a store from before v13, which has no late column.
  const late = hasLateColumn(db) ? 'late' : '0'
  const rows = db.query<{ ids: string; at: number; late: number }, { host: string; hostSessionId: string }>(
    `SELECT observation_ids AS ids, occurred_at AS at, ${late} AS late FROM injections
     WHERE host = $host AND host_session_id = $hostSessionId AND NOT (channel = 'prompt' AND observation_ids = '[]')`,
  ).all({ host, hostSessionId })
  const onTime = rows.filter((row) => row.late === 0)
  const lateOffers = new Map<number, number>()
  for (const row of rows) if (row.late !== 0) for (const id of new Set(parseIds(row.ids))) lateOffers.set(id, (lateOffers.get(id) ?? 0) + 1)
  const offeredOut = [...lateOffers.entries()].filter(([, count]) => count >= LATE_OFFERS_BEFORE_DELIVERED).map(([id]) => id)
  const sentIds = [...new Set([...onTime.flatMap((row) => parseIds(row.ids)), ...offeredOut])]
  const firstAt = onTime.length === 0 ? null : Math.min(...onTime.map((row) => row.at))
  return { sentIds, firstAt }
}

export interface SessionStart {
  id: number
  startedAt: number
}

export function sessionStartFor(db: Database, host: string, hostSessionId: string): SessionStart | null {
  return db.query<SessionStart, { host: string; hostSessionId: string }>(
    'SELECT id, started_at AS startedAt FROM sessions WHERE host = $host AND host_session_id = $hostSessionId',
  ).get({ host, hostSessionId })
}

export interface DeltaQuery {
  projectKey: string
  /** Rows written (created_at) after this. */
  since: number
  /** This session's own rows are left out; null when it has no sessions row yet. */
  excludeSessionId: number | null
  limit: number
}

/**
 * Current (not contradicted) observations of the project written after
 * `since` by other sessions, newest first, with their confirmation counts
 * (0 on a read-only store from before v5).
 */
export function deltaCandidates(db: Database, query: DeltaQuery): PackObservation[] {
  const confirmed = hasLinksTable(db) ? confirmationsColumn('o') : '0 AS confirmedBy'
  return db.query<PackObservation, Record<string, string | number>>(
    `SELECT o.id, o.host, o.title, o.evidence, o.contradicted_by AS contradictedBy, NULL AS contradictionKind, o.occurred_at AS occurredAt,
       ${confirmed}
     FROM observations o
     WHERE o.project_key = $projectKey AND o.created_at > $since AND o.contradicted_by IS NULL
       AND (o.session_id IS NULL OR o.session_id <> $exclude)
     ORDER BY o.created_at DESC, o.id DESC LIMIT $limit`,
  ).all({ projectKey: query.projectKey, since: query.since, exclude: query.excludeSessionId ?? -1, limit: query.limit })
}
