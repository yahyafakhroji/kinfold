// SQL for a purge. A target (an observation, session, project, host, date
// range, or one row a finding points at) becomes one WHERE clause per table,
// so a dry run counts exactly what a real run deletes. Children go before
// parents, and the findings that point at doomed rows go first, while those
// rows can still be matched. Clauses are built from fixed fragments; caller
// values only ever travel as bound parameters. Observation links cascade with
// either end; a row that a purged row had hidden is shown again, unless a
// remaining link may still hide it (settleContradictions re-applies those).
// mcp_reads (v6) has no session: a project, host or date-range purge deletes
// its rows directly, and purged observation ids leave every row's
// returned_ids, as they leave injections.
// Shared summaries (v7): a summary goes when it is in scope or its last
// pointing prompt is purged, and stays while a surviving prompt points at it.
// A kept summary whose own prompt goes moves to its earliest surviving
// pointer, so the session cascade cannot take it, and its count is redone.

import type { Database } from '../sqlite/types'
import { linkTargets, settleContradictions } from './observation-links'
import { EXPIRE_WHERE } from './retention-store'
import { recountSummaries } from './summary-share'

export type PurgeTarget =
  | { kind: 'observation'; id: number }
  | { kind: 'session'; id: number }
  | { kind: 'project'; key: string }
  | { kind: 'host'; host: string }
  | { kind: 'range'; after: number | null; before: number }
  | { kind: 'event'; eventId: string }
  | { kind: 'prompt'; id: number }
  | { kind: 'summary'; id: number }
  /** Retention: rows of one table older than a cutoff (summaries by last use, see EXPIRE_WHERE). A range stays on occurred_at. */
  | { kind: 'expire'; table: 'observations' | 'summaries'; before: number }

/** Delete order: every table after the ones that point at it. */
export const PURGE_TABLES = ['injections', 'mcp_reads', 'observer_runs', 'summaries', 'events', 'prompts', 'observations', 'sessions', 'context_packs', 'projects'] as const
export type PurgeTable = (typeof PURGE_TABLES)[number]

export type PurgeCounts = Record<PurgeTable | 'findings' | 'injectionsTrimmed' | 'links', number>

export interface PurgeScope {
  where: Readonly<Record<PurgeTable, string>>
  params: Readonly<Record<string, string | number>>
}

const NONE = '0'
const EMPTY: Record<PurgeTable, string> = Object.fromEntries(PURGE_TABLES.map((table) => [table, NONE])) as Record<PurgeTable, string>

function only(table: PurgeTable, clause: string): Record<PurgeTable, string> {
  return { ...EMPTY, [table]: clause }
}

/** Everything a set of sessions owns, plus extra per-table clauses joined with OR. */
function bySessions(sessions: string, extra: Partial<Record<PurgeTable, string>> = {}): Record<PurgeTable, string> {
  const owned = `session_id IN (${sessions})`
  const base: Record<PurgeTable, string> = {
    ...EMPTY,
    injections: `${owned} OR (host, host_session_id) IN (SELECT host, host_session_id FROM sessions WHERE id IN (${sessions}))`,
    observer_runs: owned,
    summaries: owned,
    events: owned,
    prompts: owned,
    observations: owned,
    sessions: `id IN (${sessions})`,
  }
  return Object.fromEntries(PURGE_TABLES.map((table) => {
    const more = extra[table]
    return [table, more === undefined ? base[table] : base[table] === NONE ? more : `(${base[table]}) OR (${more})`]
  })) as Record<PurgeTable, string>
}

function rangeScope(): Record<PurgeTable, string> {
  const within = (column: string): string => `${column} >= $after AND ${column} < $before`
  return bySessions('SELECT id FROM sessions WHERE started_at >= $after AND last_event_at < $before', {
    injections: within('occurred_at'),
    observer_runs: within('started_at'),
    summaries: within('occurred_at'),
    events: within('occurred_at'),
    prompts: within('occurred_at'),
    observations: within('occurred_at'),
    mcp_reads: within('occurred_at'),
  })
}

/** A prompt pointing at summaries.id that the scope's prompts clause purges (or, with survives, keeps). */
function pointer(prompts: string, survives: boolean): string {
  return `EXISTS (SELECT 1 FROM prompts WHERE prompts.summary_id = summaries.id AND ${survives ? 'NOT ' : ''}(${prompts}))`
}

/** Scopes that purge prompts also take summaries left without a pointer, and spare those a surviving prompt still uses. */
function shareSummaries(where: Record<PurgeTable, string>): Record<PurgeTable, string> {
  if (where.prompts === NONE) return where
  return { ...where, summaries: `((${where.summaries}) OR ${pointer(where.prompts, false)}) AND NOT ${pointer(where.prompts, true)}` }
}

export function scopeFor(target: PurgeTarget): PurgeScope {
  const scope = baseScope(target)
  return { ...scope, where: shareSummaries(scope.where) }
}

function baseScope(target: PurgeTarget): { where: Record<PurgeTable, string>; params: Record<string, string | number> } {
  switch (target.kind) {
    case 'observation':
      return { where: only('observations', 'id = $id'), params: { id: target.id } }
    case 'event':
      return { where: only('events', 'event_id = $id'), params: { id: target.eventId } }
    case 'prompt':
      return { where: only('prompts', 'id = $id'), params: { id: target.id } }
    case 'summary':
      return { where: only('summaries', 'id = $id'), params: { id: target.id } }
    case 'expire':
      return { where: only(target.table, EXPIRE_WHERE[target.table]), params: { before: target.before } }
    case 'session':
      return { where: bySessions('SELECT id FROM sessions WHERE id = $id'), params: { id: target.id } }
    case 'host':
      return { where: bySessions('SELECT id FROM sessions WHERE host = $host', { observations: 'host = $host', injections: 'host = $host', mcp_reads: 'host = $host' }), params: { host: target.host } }
    case 'project': {
      const extra = {
        observations: 'project_key = $key', injections: 'project_key = $key', mcp_reads: 'project_key = $key',
        context_packs: 'project_key = $key', projects: 'key = $key',
      }
      return { where: bySessions('SELECT id FROM sessions WHERE project_key = $key', extra), params: { key: target.key } }
    }
    case 'range':
      return { where: rangeScope(), params: { after: target.after ?? Number.MIN_SAFE_INTEGER, before: target.before } }
  }
}

/** Injections whose every id is purged: they would point at nothing. */
const ONLY_PURGED = `EXISTS (SELECT 1 FROM json_each(injections.observation_ids))
  AND NOT EXISTS (SELECT 1 FROM json_each(injections.observation_ids) j WHERE j.value NOT IN (SELECT value FROM json_each($purged)))`
const ANY_PURGED = 'EXISTS (SELECT 1 FROM json_each(injections.observation_ids) j WHERE j.value IN (SELECT value FROM json_each($purged)))'

/** Links with either end purged; the foreign keys delete them, this only counts them. */
const LINKS_PURGED = 'from_id IN (SELECT value FROM json_each($purged)) OR to_id IN (SELECT value FROM json_each($purged))'

function injectionsWhere(scope: PurgeScope): string {
  return `(${scope.where.injections}) OR (${ONLY_PURGED})`
}

function findingsWhere(scope: PurgeScope): string {
  const { where } = scope
  return [
    `(table_name = 'events' AND row_id IN (SELECT event_id FROM events WHERE ${where.events}))`,
    `(table_name = 'prompts' AND row_id IN (SELECT CAST(id AS TEXT) FROM prompts WHERE ${where.prompts}))`,
    `(table_name = 'observations' AND row_id IN (SELECT CAST(id AS TEXT) FROM observations WHERE ${where.observations}))`,
    `(table_name = 'summaries' AND row_id IN (SELECT CAST(id AS TEXT) FROM summaries WHERE ${where.summaries}))`,
  ].join(' OR ')
}

export function purgedObservationIds(db: Database, scope: PurgeScope): number[] {
  return db.query<{ id: number }, Record<string, string | number>>(`SELECT id FROM observations WHERE ${scope.where.observations} ORDER BY id`)
    .all({ ...scope.params }).map((row) => row.id)
}

/** Projects whose packs read a doomed observation or summary. */
export function affectedProjects(db: Database, scope: PurgeScope): string[] {
  const { where } = scope
  return db.query<{ key: string }, Record<string, string | number>>(
    `SELECT project_key AS key FROM observations WHERE ${where.observations}
     UNION SELECT project_key FROM sessions WHERE ${where.sessions}
     UNION SELECT project_key FROM sessions WHERE id IN (SELECT session_id FROM summaries WHERE ${where.summaries})
     ORDER BY 1`,
  ).all({ ...scope.params }).map((row) => row.key)
}

function countWhere(db: Database, table: string, where: string, params: Record<string, string | number>): number {
  return db.query<{ n: number }, Record<string, string | number>>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(params)?.n ?? 0
}

/** What deleteScope would remove, without changing anything. */
export function countScope(db: Database, scope: PurgeScope, purgedIds: readonly number[]): PurgeCounts {
  const params = { ...scope.params, purged: JSON.stringify(purgedIds) }
  const tables = Object.fromEntries(PURGE_TABLES.map((table) => [table, countWhere(db, table, scope.where[table], params)])) as Record<PurgeTable, number>
  return {
    ...tables,
    injections: countWhere(db, 'injections', injectionsWhere(scope), params),
    injectionsTrimmed: countWhere(db, 'injections', `NOT (${injectionsWhere(scope)}) AND ${ANY_PURGED}`, params),
    findings: countWhere(db, 'redaction_findings', findingsWhere(scope), params),
    links: countWhere(db, 'observation_links', LINKS_PURGED, params),
  }
}

/** Kept summaries whose own prompt the scope purges move to their earliest surviving pointer; returns the ids to recount. */
function rehomeSummaries(db: Database, scope: PurgeScope, params: Record<string, string | number>): number[] {
  const prompts = scope.where.prompts
  if (prompts === NONE) return []
  const touched = db.query<{ id: number }, Record<string, string | number>>(
    `SELECT id FROM summaries WHERE ${pointer(prompts, false)} AND NOT (${scope.where.summaries})`,
  ).all(params).map((row) => row.id)
  db.query(
    `UPDATE summaries SET (session_id, prompt_number) = (SELECT session_id, prompt_number FROM prompts
       WHERE prompts.summary_id = summaries.id AND NOT (${prompts}) ORDER BY occurred_at, id LIMIT 1)
     WHERE ${pointer(prompts, true)} AND NOT EXISTS (SELECT 1 FROM prompts WHERE prompts.summary_id = summaries.id
       AND prompts.session_id = summaries.session_id AND prompts.prompt_number = summaries.prompt_number AND NOT (${prompts}))`,
  ).run(params)
  return touched
}

function deleteWhere(db: Database, table: string, where: string, params: Record<string, string | number>): void {
  db.query(`DELETE FROM ${table} WHERE ${where}`).run(params)
}

/**
 * Deletes in dependency order; the caller owns the transaction. Mixed
 * injections lose only the purged ids. The counts come from countScope just
 * before, in the same transaction: `changes` after a DELETE that fires the
 * FTS triggers also counts the FTS shadow-table writes.
 */
export function deleteScope(db: Database, scope: PurgeScope, purgedIds: readonly number[]): PurgeCounts {
  const counts = countScope(db, scope, purgedIds)
  const revealed = linkTargets(db, purgedIds)
  const params = { ...scope.params, purged: JSON.stringify(purgedIds) }
  const recount = rehomeSummaries(db, scope, scope.params)
  deleteWhere(db, 'redaction_findings', findingsWhere(scope), params)
  deleteWhere(db, 'injections', injectionsWhere(scope), params)
  db.query(
    `UPDATE injections SET observation_ids = (SELECT json_group_array(j.value) FROM json_each(injections.observation_ids) j
       WHERE j.value NOT IN (SELECT value FROM json_each($purged))) WHERE ${ANY_PURGED}`,
  ).run({ purged: params.purged })
  db.query(
    `UPDATE mcp_reads SET returned_ids = (SELECT json_group_array(j.value) FROM json_each(mcp_reads.returned_ids) j
       WHERE j.value NOT IN (SELECT value FROM json_each($purged)))
     WHERE EXISTS (SELECT 1 FROM json_each(mcp_reads.returned_ids) j WHERE j.value IN (SELECT value FROM json_each($purged)))`,
  ).run({ purged: params.purged })
  for (const table of PURGE_TABLES.slice(1)) deleteWhere(db, table, scope.where[table], params)
  settleContradictions(db, revealed)
  recountSummaries(db, recount)
  return counts
}

/** Rebuilds the FTS index into one segment, so deleted terms leave the file, not just the index. */
export function optimizeFts(db: Database): void {
  db.run("INSERT INTO observations_fts(observations_fts) VALUES ('optimize')")
}
