// One model's vectors in memory, for the search worker. A search on SQLite
// reads every vector row of the model, a page each, decrypted: about 0.7 s
// warm and seconds cold on a store of 22,000 observations. Here the vectors sit
// as 16-bit floats (3 KB per 1536-dim row) and a scan takes tens of
// milliseconds. The cache only picks candidates: their exact distances come
// from the store with the same SQL function the scan uses, which also drops a
// row deleted or moved since the cache loaded. Rows change in place (the
// worker refreshes them as the indexer writes), so this module mutates.

import type { Database } from '../sqlite/types'
import {
  MAX_DISTANCE_IDS, NO_FILTERS, type NearestFilters, type NearestQuery, type VectorHit, type VectorSpace, decodeVector, distancesFor,
} from '../store/vector-store'

/** Candidates checked against the store per search: at least this many, and four for every hit asked for. */
export const MIN_CANDIDATES = 64
const CANDIDATES_PER_HIT = 4

export interface CacheRow {
  id: number
  project: string
  vector: Float16Array
  norm: number
}

export interface SpaceCache {
  model: string
  dims: number
  rows: CacheRow[]
  /** observation id -> its index in rows. */
  index: Map<number, number>
}

const ROWS_SQL = `SELECT v.observation_id AS id, o.project_key AS project, v.embedding AS embedding
  FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
  WHERE v.model = $model AND v.dims = $dims`

interface StoredRow {
  id: number
  project: string
  embedding: Uint8Array
}

function toRow(stored: StoredRow): CacheRow {
  const full = decodeVector(stored.embedding)
  let sum = 0
  for (let j = 0; j < full.length; j += 1) sum += full[j]! * full[j]!
  return { id: stored.id, project: stored.project, vector: new Float16Array(full), norm: Math.sqrt(sum) }
}

export function loadSpaceCache(db: Database, space: VectorSpace): SpaceCache {
  const stored = db.query<StoredRow, Record<string, string | number>>(ROWS_SQL).all({ model: space.model, dims: space.dims })
  const rows = stored.map(toRow)
  return { model: space.model, dims: space.dims, rows, index: new Map(rows.map((row, at) => [row.id, at])) }
}

function removeRow(cache: SpaceCache, id: number): void {
  const at = cache.index.get(id)
  if (at === undefined) return
  const last = cache.rows.pop()!
  cache.index.delete(id)
  if (last.id !== id) {
    cache.rows[at] = last
    cache.index.set(last.id, at)
  }
}

/** Re-reads the named rows: a new or re-embedded vector is taken, a row gone from the store or this model is dropped. */
export function refreshCacheRows(db: Database, cache: SpaceCache, ids: readonly number[]): void {
  if (ids.length === 0) return
  for (const id of ids) removeRow(cache, id)
  const stored = db.query<StoredRow, Record<string, string | number>>(`${ROWS_SQL} AND v.observation_id IN (SELECT value FROM json_each($ids))`)
    .all({ model: cache.model, dims: cache.dims, ids: JSON.stringify(ids) })
  for (const row of stored.map(toRow)) {
    cache.index.set(row.id, cache.rows.length)
    cache.rows.push(row)
  }
}

export const SPACE_IDS_SQL = 'SELECT observation_id AS id FROM observation_vectors WHERE model = $model AND dims = $dims'

/**
 * Drops cached rows the store no longer has in this space, after retention,
 * purge or resolve. It reads observation_vectors_by_space alone, never a
 * vector page, so it is cheap enough to run after every such pass.
 */
export function pruneCache(db: Database, cache: SpaceCache): void {
  const live = new Set(db.query<{ id: number }, Record<string, string | number>>(SPACE_IDS_SQL).all({ model: cache.model, dims: cache.dims }).map((row) => row.id))
  for (const row of [...cache.rows]) if (!live.has(row.id)) removeRow(cache, row.id)
}

/** The n rows nearest the query by cosine distance, in the project when one is named; ties go to the higher id, as in the SQL scan. */
export function candidateIds(cache: SpaceCache, vector: Float32Array, project: string | null, n: number): number[] {
  let queryNorm = 0
  for (let j = 0; j < vector.length; j += 1) queryNorm += vector[j]! * vector[j]!
  queryNorm = Math.sqrt(queryNorm)
  if (queryNorm === 0 || n <= 0) return []
  const scored: { id: number; distance: number }[] = []
  for (const row of cache.rows) {
    if (row.norm === 0 || (project !== null && row.project !== project)) continue
    const v = row.vector
    let dot = 0
    for (let j = 0; j < v.length; j += 1) dot += v[j]! * vector[j]!
    scored.push({ id: row.id, distance: 1 - dot / (row.norm * queryNorm) })
  }
  scored.sort((a, b) => a.distance - b.distance || b.id - a.id)
  return scored.slice(0, n).map((row) => row.id)
}

export function hasFilters(filters: NearestFilters | undefined): boolean {
  const f = filters ?? NO_FILTERS
  return f.type !== null || f.host !== null || f.evidence !== null
}

/** Exact distances for the ids from the store, in MAX_DISTANCE_IDS slices, sorted as the SQL scan sorts. */
function exactDistances(db: Database, query: NearestQuery, ids: readonly number[]): VectorHit[] {
  const hits: VectorHit[] = []
  for (let at = 0; at < ids.length; at += MAX_DISTANCE_IDS) {
    hits.push(...distancesFor(db, { model: query.model, vector: query.vector, project: query.project, ids: ids.slice(at, at + MAX_DISTANCE_IDS) }))
  }
  return hits.sort((a, b) => a.distance - b.distance || b.id - a.id)
}

/**
 * nearestObservations for a query without filters, from the cache. Rows the
 * store no longer has fall out at the exact check; when that leaves fewer than
 * k, the candidate set grows until it covers every cached row.
 */
export function cachedNearest(db: Database, cache: SpaceCache, query: NearestQuery): VectorHit[] {
  let n = Math.max(MIN_CANDIDATES, query.k * CANDIDATES_PER_HIT)
  for (;;) {
    const ids = candidateIds(cache, query.vector, query.project, n)
    const hits = exactDistances(db, query, ids)
    if (hits.length >= query.k || ids.length < n) return hits.slice(0, query.k)
    n *= 2
  }
}
