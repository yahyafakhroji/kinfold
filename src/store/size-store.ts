// Size queries for the data-control page. dbstat gives exact bytes per table
// and index; SQLite builds without it fall back to the page count for the
// whole file and stored text lengths per table. Indexes and FTS shadow tables
// roll up into the table they serve. Read-only.

import type { Database } from '../sqlite/types'

export type SizeSource = 'dbstat' | 'page_count'

export interface TableBytes {
  name: string
  bytes: number
}

export interface PageInfo {
  pageSize: number
  pageCount: number
  freelistPages: number
}

export interface ProjectBytes {
  projectKey: string
  displayName: string
  /** Stored text length (payload, prompt text, observation text): what retention and purge can free. */
  eventBytes: number
  promptBytes: number
  observationBytes: number
  events: number
  observations: number
}

function pragmaNumber(db: Database, name: string): number {
  const row = db.query<Record<string, number>, []>(`PRAGMA ${name}`).get()
  return row === null ? 0 : Number(Object.values(row)[0] ?? 0)
}

export function pageInfo(db: Database): PageInfo {
  return { pageSize: pragmaNumber(db, 'page_size'), pageCount: pragmaNumber(db, 'page_count'), freelistPages: pragmaNumber(db, 'freelist_count') }
}

/** observations_fts_data and friends count as observations_fts; an index counts as its table. */
function owner(name: string, tableOf: ReadonlyMap<string, string>): string {
  if (name.startsWith('observations_fts')) return 'observations_fts'
  return tableOf.get(name) ?? name
}

function dbstatBytes(db: Database): TableBytes[] {
  const tableOf = new Map(db.query<{ name: string; tbl: string }, []>('SELECT name, tbl_name AS tbl FROM sqlite_master').all().map((row) => [row.name, row.tbl]))
  const totals = new Map<string, number>()
  for (const row of db.query<{ name: string; bytes: number }, []>('SELECT name, sum(pgsize) AS bytes FROM dbstat GROUP BY name').all()) {
    const name = owner(row.name, tableOf)
    totals.set(name, (totals.get(name) ?? 0) + row.bytes)
  }
  return [...totals].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
}

const TEXT_ESTIMATES: readonly (readonly [string, string])[] = [
  ['events', 'sum(length(coalesce(payload, \'\')) + length(redactions))'],
  ['prompts', 'sum(length(text))'],
  ['observations', 'sum(length(title) + length(narrative) + length(facts) + length(files))'],
  ['summaries', "sum(length(coalesce(request, '')) + length(coalesce(learned, '')) + length(coalesce(completed, '')) + length(coalesce(next_steps, '')))"],
  ['context_packs', 'sum(length(body))'],
]

function estimatedBytes(db: Database): TableBytes[] {
  return TEXT_ESTIMATES.map(([name, sum]) => ({ name, bytes: db.query<{ n: number | null }, []>(`SELECT ${sum} AS n FROM ${name}`).get()?.n ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes)
}

/** Exact bytes per table when dbstat exists, else stored text length per large table. */
export function tableBytes(db: Database): { source: SizeSource; tables: TableBytes[] } {
  try {
    return { source: 'dbstat', tables: dbstatBytes(db) }
  } catch {
    // This SQLite was built without SQLITE_ENABLE_DBSTAT_VTAB.
    return { source: 'page_count', tables: estimatedBytes(db) }
  }
}

/** Largest first. Counts text lengths, so it stays meaningful without dbstat. */
export function projectBytes(db: Database, limit: number): ProjectBytes[] {
  return db.query<ProjectBytes, { limit: number }>(
    `SELECT p.key AS projectKey, p.display_name AS displayName,
       coalesce((SELECT sum(length(coalesce(e.payload, ''))) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.project_key = p.key), 0) AS eventBytes,
       coalesce((SELECT sum(length(r.text)) FROM prompts r JOIN sessions s ON s.id = r.session_id WHERE s.project_key = p.key), 0) AS promptBytes,
       coalesce((SELECT sum(length(o.title) + length(o.narrative) + length(o.facts) + length(o.files)) FROM observations o WHERE o.project_key = p.key), 0) AS observationBytes,
       (SELECT count(*) FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.project_key = p.key) AS events,
       (SELECT count(*) FROM observations o WHERE o.project_key = p.key) AS observations
     FROM projects p ORDER BY eventBytes + promptBytes + observationBytes DESC, p.key LIMIT $limit`,
  ).all({ limit })
}
