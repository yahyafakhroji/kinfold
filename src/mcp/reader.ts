// The MCP server's view of the store: observations, summaries and the
// sessions row that scopes them, never the events table (payloads stay out
// of every MCP answer). Decision D3 keeps writes in the daemon, so the
// database is opened read-only once, the same way the context fallback opens
// it, and every query is prepared up front so a search is one bound call.
// A null project means "all projects" (the tools' `project: "*"`).

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { openReadOnly } from '../context/fallback'
import type { Database, Statement } from '../sqlite/types'
import { DB_FILE } from '../store/data-dir'
import { confirmBoostSql, confirmationsColumn, contradictionKindColumn, hasLinksTable } from '../store/observation-links'

export interface IndexRow {
  id: number
  projectKey: string
  host: string
  type: string
  evidence: string
  title: string
  contradictedBy: number | null
  /** The link kind behind contradictedBy; null without one (or on a pre-v5 store). */
  contradictionKind: 'updates' | 'contradicts' | null
  occurredAt: number
  /** Current observations that confirm this one (P1-I); 0 on a pre-v5 store. */
  confirmedBy: number
}

export interface FullObservation extends IndexRow {
  sessionId: number | null
  promptNumber: number | null
  narrative: string
  facts: string[]
  files: string[]
  sourceEventIds: string[]
  observerModel: string | null
  /** Older observations this one disproves. */
  contradicts: number[]
}

export interface SummaryItem {
  id: number
  sessionId: number
  host: string
  promptNumber: number
  request: string | null
  learned: string | null
  completed: string | null
  nextSteps: string | null
  occurredAt: number
  /** Prompts sharing this summary (v7): identical prompts of the project; 1 on a pre-v7 store. */
  repeatCount: number
  lastSeenAt: number
}

export interface SessionRef {
  id: number
  host: string
  projectKey: string
}

export interface SearchFilters {
  project: string | null
  type: string | null
  host: string | null
  evidence: string | null
  limit: number
  offset: number
}

export interface Around {
  observationsBefore: IndexRow[]
  observationsAfter: IndexRow[]
  summariesBefore: SummaryItem[]
  summariesAfter: SummaryItem[]
}

export interface SessionItems {
  observations: IndexRow[]
  summaries: SummaryItem[]
  observationTotal: number
  summaryTotal: number
}

export interface MemoryReader {
  search(match: string, filters: SearchFilters): IndexRow[]
  /** The rows among ids that pass the search filters (the vector half of hybrid search, P2-A); any order. */
  indexRows(ids: readonly number[], filters: Omit<SearchFilters, 'limit' | 'offset'>): IndexRow[]
  observation(id: number, project: string | null): IndexRow | null
  around(anchor: IndexRow, project: string | null, before: number, after: number): Around
  session(id: number): SessionRef | null
  sessionItems(sessionId: number, cap: number): SessionItems
  observations(ids: readonly number[], project: string | null): FullObservation[]
  close(): void
}

type Bindings = Record<string, string | number | null>

/** What the store the reader opened has: links (v5) and shared summaries (v7). */
interface StoreFeatures {
  hasLinks: boolean
  hasSharing: boolean
}

/**
 * The reader opens the file read-only and may meet a store the daemon has not
 * migrated to v5 yet; without observation_links the kind reads as NULL and
 * the confirmation count as 0.
 */
function indexColumns(hasLinks: boolean): string {
  return `o.id, o.project_key AS projectKey, o.host, o.type, o.evidence, o.title,
  o.contradicted_by AS contradictedBy, ${hasLinks ? contradictionKindColumn('o') : 'NULL AS contradictionKind'}, o.occurred_at AS occurredAt,
  ${hasLinks ? confirmationsColumn('o') : '0 AS confirmedBy'}`
}

/** Before v7 every summary stands alone: count 1, last seen when it happened. */
function summaryColumns(hasSharing: boolean): string {
  return `m.id, m.session_id AS sessionId, s.host, m.prompt_number AS promptNumber, m.request, m.learned,
  m.completed, m.next_steps AS nextSteps, m.occurred_at AS occurredAt,
  ${hasSharing ? 'm.repeat_count AS repeatCount, coalesce(m.last_seen_at, m.occurred_at) AS lastSeenAt' : '1 AS repeatCount, m.occurred_at AS lastSeenAt'}`
}

/** A session's summaries: its own rows, plus (v7) shared rows its prompts point at, each once. */
function sessionSummaryScope(hasSharing: boolean): string {
  const shared = hasSharing ? ' OR m.id IN (SELECT summary_id FROM prompts WHERE session_id = $sessionId AND summary_id IS NOT NULL)' : ''
  return `(m.session_id = $sessionId${shared})`
}

/** Relevance (bm25: lower is better) scaled by 1 + the confirmation boost, so a confirmed match moves up. */
function searchOrder(hasLinks: boolean): string {
  return hasLinks ? `bm25(observations_fts) * (1 + ${confirmBoostSql('confirmedBy')}), o.id DESC` : 'bm25(observations_fts), o.id DESC'
}
const IN_SCOPE = '($project IS NULL OR o.project_key = $project)'
const FILTERS = `($type IS NULL OR o.type = $type) AND ($host IS NULL OR o.host = $host)
  AND ($evidence IS NULL OR ($evidence = 'contradicted' AND o.contradicted_by IS NOT NULL) OR o.evidence = $evidence)`
/** Strictly before the anchor in (occurred_at, id) order; ties on time break by id. */
const BEFORE = '(o.occurred_at < $at OR (o.occurred_at = $at AND o.id < $id))'
const AFTER = '(o.occurred_at > $at OR (o.occurred_at = $at AND o.id > $id))'

/** Every statement the reader prepares, shaped by what the store has. */
function sqlFor({ hasLinks, hasSharing }: StoreFeatures) {
  const INDEX_COLUMNS = indexColumns(hasLinks)
  const SUMMARY_COLUMNS = summaryColumns(hasSharing)
  const SESSION_SUMMARIES = sessionSummaryScope(hasSharing)
  return {
    search: `SELECT ${INDEX_COLUMNS} FROM observations_fts f JOIN observations o ON o.id = f.rowid
      WHERE observations_fts MATCH $match AND ${IN_SCOPE} AND ${FILTERS}
      ORDER BY ${searchOrder(hasLinks)} LIMIT $limit OFFSET $offset`,
    byIds: `SELECT ${INDEX_COLUMNS} FROM observations o
      WHERE o.id IN (SELECT value FROM json_each($ids)) AND ${IN_SCOPE} AND ${FILTERS}`,
    observation: `SELECT ${INDEX_COLUMNS} FROM observations o WHERE o.id = $id AND ${IN_SCOPE}`,
    before: `SELECT ${INDEX_COLUMNS} FROM observations o WHERE ${IN_SCOPE} AND ${BEFORE}
      ORDER BY o.occurred_at DESC, o.id DESC LIMIT $limit`,
    after: `SELECT ${INDEX_COLUMNS} FROM observations o WHERE ${IN_SCOPE} AND ${AFTER}
      ORDER BY o.occurred_at, o.id LIMIT $limit`,
    summariesBefore: `SELECT ${SUMMARY_COLUMNS} FROM summaries m JOIN sessions s ON s.id = m.session_id
      WHERE ($project IS NULL OR s.project_key = $project) AND m.occurred_at < $at
      ORDER BY m.occurred_at DESC, m.id DESC LIMIT $limit`,
    summariesAfter: `SELECT ${SUMMARY_COLUMNS} FROM summaries m JOIN sessions s ON s.id = m.session_id
      WHERE ($project IS NULL OR s.project_key = $project) AND m.occurred_at >= $at
      ORDER BY m.occurred_at, m.id LIMIT $limit`,
    session: 'SELECT id, host, project_key AS projectKey FROM sessions WHERE id = $id',
    sessionObservations: `SELECT ${INDEX_COLUMNS} FROM observations o WHERE o.session_id = $sessionId
      ORDER BY o.occurred_at, o.id LIMIT $limit`,
    sessionSummaries: `SELECT ${SUMMARY_COLUMNS} FROM summaries m JOIN sessions s ON s.id = m.session_id
      WHERE ${SESSION_SUMMARIES} ORDER BY m.occurred_at, m.id LIMIT $limit`,
    sessionCounts: `SELECT (SELECT count(*) FROM observations WHERE session_id = $sessionId) AS observations,
      (SELECT count(*) FROM summaries m WHERE ${SESSION_SUMMARIES}) AS summaries`,
    full: `SELECT ${INDEX_COLUMNS}, o.session_id AS sessionId, o.prompt_number AS promptNumber, o.narrative, o.facts, o.files,
        o.source_event_ids AS sourceEventIds, o.observer_model AS observerModel
      FROM observations o WHERE o.id IN (SELECT value FROM json_each($ids)) AND ${IN_SCOPE}`,
    contradicts: `SELECT id, contradicted_by AS contradictedBy FROM observations
      WHERE contradicted_by IN (SELECT value FROM json_each($ids)) ORDER BY id`,
  } as const
}

type SqlName = keyof ReturnType<typeof sqlFor>

type StoredFull = Omit<FullObservation, 'facts' | 'files' | 'sourceEventIds' | 'contradicts'> & {
  facts: string
  files: string
  sourceEventIds: string
}

/** A JSON list of strings from a stored column; anything else reads as empty rather than failing the read. */
export function stringList(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function hasSharedSummaries(db: Database): boolean {
  return db.query("SELECT 1 FROM pragma_table_info('summaries') WHERE name = 'repeat_count'").get() !== null
}

function prepareAll(db: Database): Record<SqlName, Statement> {
  const entries = Object.entries(sqlFor({ hasLinks: hasLinksTable(db), hasSharing: hasSharedSummaries(db) })).map(([name, sql]) => [name, db.prepare(sql)] as const)
  return Object.fromEntries(entries) as Record<SqlName, Statement>
}

function allOf<T>(statement: Statement, bindings: Bindings): T[] {
  return statement.all(bindings) as T[]
}

function toFull(row: StoredFull, contradicts: readonly { id: number; contradictedBy: number }[]): FullObservation {
  return {
    ...row,
    facts: stringList(row.facts),
    files: stringList(row.files),
    sourceEventIds: stringList(row.sourceEventIds),
    contradicts: contradicts.filter((other) => other.contradictedBy === row.id).map((other) => other.id),
  }
}

function createReader(db: Database): MemoryReader {
  const q = prepareAll(db)
  return {
    search: (match, filters) => allOf<IndexRow>(q.search, { match, ...filters }),
    indexRows: (ids, filters) => (ids.length === 0 ? [] : allOf<IndexRow>(q.byIds, { ids: JSON.stringify(ids), ...filters })),
    observation: (id, project) => (q.observation.get({ id, project }) as IndexRow | null) ?? null,
    around: (anchor, project, before, after) => {
      const at = { at: anchor.occurredAt, id: anchor.id, project }
      return {
        observationsBefore: allOf<IndexRow>(q.before, { ...at, limit: before }),
        observationsAfter: allOf<IndexRow>(q.after, { ...at, limit: after }),
        summariesBefore: allOf<SummaryItem>(q.summariesBefore, { at: anchor.occurredAt, project, limit: before }),
        summariesAfter: allOf<SummaryItem>(q.summariesAfter, { at: anchor.occurredAt, project, limit: after }),
      }
    },
    session: (id) => (q.session.get({ id }) as SessionRef | null) ?? null,
    sessionItems: (sessionId, cap) => {
      const counts = q.sessionCounts.get({ sessionId }) as { observations: number; summaries: number }
      return {
        observations: allOf<IndexRow>(q.sessionObservations, { sessionId, limit: cap }),
        summaries: allOf<SummaryItem>(q.sessionSummaries, { sessionId, limit: cap }),
        observationTotal: counts.observations,
        summaryTotal: counts.summaries,
      }
    },
    observations: (ids, project) => {
      const json = JSON.stringify(ids)
      const contradicts = allOf<{ id: number; contradictedBy: number }>(q.contradicts, { ids: json })
      return allOf<StoredFull>(q.full, { ids: json, project }).map((row) => toFull(row, contradicts))
    },
    close: () => db.close(),
  }
}

export function databasePath(dataDir: string): string {
  return join(dataDir, DB_FILE)
}

/**
 * Null while there is no database file, or when it cannot be opened read-only
 * (for example a file from before the schema had these tables).
 */
export function openMemoryReader(dataDir: string): MemoryReader | null {
  const path = databasePath(dataDir)
  if (!existsSync(path)) return null
  const db = openReadOnly(path)
  if (db === null) return null
  try {
    return createReader(db)
  } catch (error: unknown) {
    // A database without observations_fts (or another table we read) fails to prepare.
    db.close()
    if (error instanceof Error) return null
    throw error
  }
}
