// Store side of context delivery. Packs are precomputed rows keyed
// (project_key, host_profile), so serving one is a single indexed read; every
// pack served leaves an injections row (the audit log and hit-rate source).
// Reads here are plain SELECTs, so the read-only fallback can share them.

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
    `INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at, duration_ms)
     VALUES ($sessionId, $host, $hostSessionId, $projectKey, $observationIds, $channel, $tokens, $occurredAt, $durationMs) RETURNING id`,
  ).get({ ...injection, observationIds: JSON.stringify(injection.observationIds), durationMs: injection.durationMs ?? null })
  if (row === null) throw new Error('injection insert returned no row')
  return row.id
}

// --- Prompt-time deltas. Plain SELECTs, so the read-only fallback shares them. ---

/** What a host session has been handed so far, from its injections rows. */
export interface SessionDeliveries {
  /** Every observation id any injection for this host session carried. */
  sentIds: number[]
  /** When the session first received memory; null when it never did. */
  firstAt: number | null
}

export function sessionDeliveries(db: Database, host: string, hostSessionId: string): SessionDeliveries {
  const rows = db.query<{ ids: string; at: number }, { host: string; hostSessionId: string }>(
    'SELECT observation_ids AS ids, occurred_at AS at FROM injections WHERE host = $host AND host_session_id = $hostSessionId',
  ).all({ host, hostSessionId })
  const sentIds = [...new Set(rows.flatMap((row) => parseIds(row.ids)))]
  const firstAt = rows.length === 0 ? null : Math.min(...rows.map((row) => row.at))
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
