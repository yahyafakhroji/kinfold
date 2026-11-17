// Store side of prompt-time matching: the project's current
// observations that match a prompt's terms (FTS5 BM25, any term), how many of
// those terms each one holds, and rows by id for vector hits. Current only: a
// contradicted or updated observation never comes back as related memory.
// Plain SELECTs, like context-store.ts.

import type { PackObservation } from '../context/types'
import type { Database } from '../sqlite/types'
import { confirmationsColumn, hasLinksTable } from './observation-links'

function columns(db: Database): string {
  const confirmed = hasLinksTable(db) ? confirmationsColumn('o') : '0 AS confirmedBy'
  return `o.id, o.host, o.title, o.evidence, o.contradicted_by AS contradictedBy, NULL AS contradictionKind, o.occurred_at AS occurredAt, ${confirmed}`
}

export interface KeywordQuery {
  projectKey: string
  /** An FTS5 MATCH expression built by ftsMatch(). */
  match: string
  /** Never returned: what this session was already sent. */
  excludeIds: readonly number[]
  /** This session's own rows are left out, as in the delta; null when it has no sessions row yet. */
  excludeSessionId: number | null
  limit: number
}

/** The index the keyword match filters its hits through (schema v17). */
export const RECALL_INDEX = 'observations_recall'

/** Per connection: a read-only fallback can meet a store from before v17, which matches on the table as before. */
const recallIndex = new WeakMap<Database, boolean>()

function hasRecallIndex(db: Database): boolean {
  const known = recallIndex.get(db)
  if (known !== undefined) return known
  const found = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'index' AND name = ?").get(RECALL_INDEX)?.n === 1
  recallIndex.set(db, found)
  return found
}

/**
 * The ids, best BM25 first. Named so: the planner would look each hit up in
 * the table, where its project and contradiction sit behind its text, and on
 * a 30,000-memory store that read was most of a prompt's keyword time.
 */
function keywordIdsSql(db: Database): string {
  return `SELECT o.id FROM observations_fts f JOIN observations o${hasRecallIndex(db) ? ` INDEXED BY ${RECALL_INDEX}` : ''} ON o.id = f.rowid
     WHERE observations_fts MATCH $match AND o.project_key = $projectKey AND o.contradicted_by IS NULL
       AND o.id NOT IN (SELECT value FROM json_each($exclude))
       AND (o.session_id IS NULL OR o.session_id <> $session)
     ORDER BY bm25(observations_fts), o.id DESC LIMIT $limit`
}

/** The keyword match's query plan, for the test that holds it to the index. */
export function keywordIdsPlan(db: Database): string {
  return db.query<{ detail: string }, Record<string, string | number>>(`EXPLAIN QUERY PLAN ${keywordIdsSql(db)}`)
    .all({ match: 'x', projectKey: '', exclude: '[]', session: -1, limit: 1 }).map((row) => row.detail).join('\n')
}

/** Best BM25 first, then newest id. The full rows are read for the ids kept, after the match. */
export function keywordCandidates(db: Database, query: KeywordQuery): PackObservation[] {
  const ids = db.query<{ id: number }, Record<string, string | number>>(keywordIdsSql(db))
    .all({ match: query.match, projectKey: query.projectKey, exclude: JSON.stringify(query.excludeIds), session: query.excludeSessionId ?? -1, limit: query.limit })
    .map((row) => row.id)
  if (ids.length === 0) return []
  const rows = new Map(db.query<PackObservation, { ids: string }>(`SELECT ${columns(db)} FROM observations o WHERE o.id IN (SELECT value FROM json_each($ids))`)
    .all({ ids: JSON.stringify(ids) }).map((row) => [row.id, row]))
  return ids.flatMap((id) => rows.get(id) ?? [])
}

/** Current observations of the project among `ids`, other sessions' only (null: no exclusion), in no particular order. */
export function currentObservationsByIds(db: Database, projectKey: string, ids: readonly number[], excludeSessionId: number | null = null): PackObservation[] {
  if (ids.length === 0) return []
  return db.query<PackObservation, Record<string, string | number>>(
    `SELECT ${columns(db)} FROM observations o
     WHERE o.id IN (SELECT value FROM json_each($ids)) AND o.project_key = $projectKey AND o.contradicted_by IS NULL
       AND (o.session_id IS NULL OR o.session_id <> $session)`,
  ).all({ ids: JSON.stringify(ids), projectKey, session: excludeSessionId ?? -1 })
}

/**
 * For each id, how many of `matches` (one MATCH expression per prompt term)
 * its title, narrative or facts satisfy. One small query per term, through
 * the same tokenizer as the search, so "matched" means what FTS5 means.
 */
export function matchedTermCounts(db: Database, ids: readonly number[], matches: readonly string[]): Map<number, number> {
  const counts = new Map<number, number>(ids.map((id) => [id, 0]))
  if (ids.length === 0) return counts
  const statement = db.query<{ id: number }, Record<string, string>>(
    'SELECT rowid AS id FROM observations_fts WHERE observations_fts MATCH $match AND rowid IN (SELECT value FROM json_each($ids))',
  )
  const idList = JSON.stringify(ids)
  for (const match of matches) {
    for (const row of statement.all({ match, ids: idList })) counts.set(row.id, (counts.get(row.id) ?? 0) + 1)
  }
  return counts
}

/** Per connection: the vocabulary table lives in its temp schema, so each connection makes its own once. */
const vocabReady = new WeakSet<Database>()

/** How long a term's memory count is kept per connection: shares move slowly, and asking the vocabulary is a cold read after every write. */
export const TERM_COUNT_TTL_MS = 60_000
/** Terms kept per connection; past this the oldest go. */
const TERM_COUNT_KEEP = 5_000
const termCounts = new WeakMap<Database, Map<string, { doc: number; at: number }>>()

/**
 * How many observations hold each term, from FTS5's own index (an fts5vocab
 * table in the connection's temp schema: nothing is written to the store, so a
 * read-only connection can make it). A term the index has never seen is 0.
 * Counts are kept TERM_COUNT_TTL_MS per connection: a writer's commit empties
 * a reader's page cache, so every prompt read the vocabulary cold.
 */
export function termDocCounts(db: Database, terms: readonly string[], now: number = Date.now()): Map<string, number> {
  if (!vocabReady.has(db)) {
    db.run("CREATE VIRTUAL TABLE IF NOT EXISTS temp.kinfold_fts_vocab USING fts5vocab(main, observations_fts, 'row')")
    vocabReady.add(db)
  }
  const kept = termCounts.get(db) ?? new Map<string, { doc: number; at: number }>()
  termCounts.set(db, kept)
  // The index holds terms as its unicode61 tokenizer folds them, without accents: "café" is stored as "cafe".
  const folded = terms.map(foldTerm)
  const missing = [...new Set(folded)].filter((term) => {
    const entry = kept.get(term)
    return entry === undefined || now - entry.at >= TERM_COUNT_TTL_MS
  })
  if (missing.length > 0) {
    const rows = db.query<{ term: string; doc: number }, { terms: string }>('SELECT term, doc FROM temp.kinfold_fts_vocab WHERE term IN (SELECT value FROM json_each($terms))')
      .all({ terms: JSON.stringify(missing) })
    const docs = new Map(rows.map((row) => [row.term, row.doc]))
    for (const term of missing) {
      kept.delete(term)
      kept.set(term, { doc: docs.get(term) ?? 0, at: now })
    }
    while (kept.size > TERM_COUNT_KEEP) kept.delete(kept.keys().next().value!)
  }
  return new Map(terms.map((term, index) => [term, kept.get(folded[index]!)?.doc ?? 0]))
}

/** A term as FTS5's default tokenizer stores it: lowercase, accents removed. */
export function foldTerm(term: string): string {
  return term.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Per connection, for a minute: count(*) walks the table, and the share it sets moves slowly. */
const totals = new WeakMap<Database, { at: number; count: number }>()
const TOTAL_TTL_MS = 60_000

export function observationCount(db: Database, now: number = Date.now()): number {
  const known = totals.get(db)
  if (known !== undefined && now - known.at < TOTAL_TTL_MS) return known.count
  const count = db.query<{ n: number }, []>('SELECT count(*) AS n FROM observations').get()?.n ?? 0
  totals.set(db, { at: now, count })
  return count
}
