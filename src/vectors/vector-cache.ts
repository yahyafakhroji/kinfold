// One model's vectors in memory, for the search worker. A search on SQLite
// reads every vector row of the model, a page each, decrypted: about 0.7 s
// warm and seconds cold on a store of 22,000 observations. Here the vectors sit
// as 16-bit floats in one flat array (3 KB per 1536-dim row) and a scan takes
// tens of milliseconds. The cache only picks candidates: their exact distances
// come from the store with the same SQL function the scan uses, which also
// drops a row deleted or moved since the cache loaded. The load reads pages of
// rows so it never holds every blob at once. Rows change in place (the worker
// refreshes them as the indexer writes), so this module mutates.

import type { Database } from '../sqlite/types'
import {
  MAX_DISTANCE_IDS, NO_FILTERS, type NearestFilters, type NearestQuery, type VectorHit, type VectorSpace, decodeVector, distancesFor,
} from '../store/vector-store'

/** Candidates checked against the store per search: at least this many, and four for every hit asked for. */
export const MIN_CANDIDATES = 64
const CANDIDATES_PER_HIT = 4
/** Rows read per query while loading: their blobs are the load's peak memory beyond the cache itself. */
export const LOAD_PAGE_ROWS = 2_000
const GROWTH = 1.5

export interface SpaceCache {
  model: string
  dims: number
  /** Rows in use; row i holds data[i * dims .. (i + 1) * dims). */
  count: number
  ids: number[]
  projects: string[]
  norms: number[]
  data: Float16Array
  /** observation id -> its row. */
  index: Map<number, number>
}

const ROWS_SQL = `SELECT v.observation_id AS id, o.project_key AS project, v.embedding AS embedding
  FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
  WHERE v.model = $model AND v.dims = $dims`

export const SPACE_IDS_SQL = 'SELECT observation_id AS id FROM observation_vectors WHERE model = $model AND dims = $dims'

interface StoredRow {
  id: number
  project: string
  embedding: Uint8Array
}

/** The blob as float32, viewed in place when it is aligned and copied only when it is not. */
function floatsOf(blob: Uint8Array, dims: number): Float32Array {
  return blob.byteOffset % 4 === 0 && blob.byteLength === dims * 4 ? new Float32Array(blob.buffer, blob.byteOffset, dims) : decodeVector(blob)
}

function ensureRows(cache: SpaceCache, rows: number): void {
  if (rows * cache.dims <= cache.data.length) return
  const grown = new Float16Array(Math.max(rows, Math.ceil((cache.data.length / Math.max(cache.dims, 1)) * GROWTH)) * cache.dims)
  grown.set(cache.data.subarray(0, cache.count * cache.dims))
  cache.data = grown
}

function appendRow(cache: SpaceCache, stored: StoredRow): void {
  const floats = floatsOf(stored.embedding, cache.dims)
  let sum = 0
  for (let j = 0; j < floats.length; j += 1) sum += floats[j]! * floats[j]!
  ensureRows(cache, cache.count + 1)
  cache.data.set(floats, cache.count * cache.dims)
  cache.ids[cache.count] = stored.id
  cache.projects[cache.count] = stored.project
  cache.norms[cache.count] = Math.sqrt(sum)
  cache.index.set(stored.id, cache.count)
  cache.count += 1
}

function removeRow(cache: SpaceCache, id: number): void {
  const at = cache.index.get(id)
  if (at === undefined) return
  const last = cache.count - 1
  cache.index.delete(id)
  if (at !== last) {
    cache.data.copyWithin(at * cache.dims, last * cache.dims, (last + 1) * cache.dims)
    cache.ids[at] = cache.ids[last]!
    cache.projects[at] = cache.projects[last]!
    cache.norms[at] = cache.norms[last]!
    cache.index.set(cache.ids[at]!, at)
  }
  cache.ids.length = last
  cache.projects.length = last
  cache.norms.length = last
  cache.count = last
}

export function loadSpaceCache(db: Database, space: VectorSpace): SpaceCache {
  const params = { model: space.model, dims: space.dims }
  const expected = db.query<{ n: number }, Record<string, string | number>>(`SELECT count(*) AS n FROM (${SPACE_IDS_SQL})`).get(params)?.n ?? 0
  const cache: SpaceCache = { ...params, count: 0, ids: [], projects: [], norms: [], data: new Float16Array(expected * space.dims), index: new Map() }
  const page = db.query<StoredRow, Record<string, string | number>>(`${ROWS_SQL} AND v.observation_id > $after ORDER BY v.observation_id LIMIT $limit`)
  for (let after = -1; ;) {
    const rows = page.all({ ...params, after, limit: LOAD_PAGE_ROWS })
    for (const row of rows) appendRow(cache, row)
    // Each page's blobs are garbage once copied, but nothing collects them during a synchronous load, so the
    // peak was every blob at once (231 MB for 22,000 rows; 102 MB with this). It runs once, in the worker's own heap.
    Bun.gc(true)
    if (rows.length < LOAD_PAGE_ROWS) return cache
    after = rows[rows.length - 1]!.id
  }
}

/** Re-reads the named rows: a new or re-embedded vector is taken, a row gone from the store or this model is dropped. */
export function refreshCacheRows(db: Database, cache: SpaceCache, ids: readonly number[]): void {
  if (ids.length === 0) return
  for (const id of ids) removeRow(cache, id)
  const stored = db.query<StoredRow, Record<string, string | number>>(`${ROWS_SQL} AND v.observation_id IN (SELECT value FROM json_each($ids))`)
    .all({ model: cache.model, dims: cache.dims, ids: JSON.stringify(ids) })
  for (const row of stored) appendRow(cache, row)
}

/**
 * Drops cached rows the store no longer has in this space, after retention,
 * purge or resolve. It reads observation_vectors_by_space alone, never a
 * vector page, so it is cheap enough to run after every such pass.
 */
export function pruneCache(db: Database, cache: SpaceCache): void {
  const live = new Set(db.query<{ id: number }, Record<string, string | number>>(SPACE_IDS_SQL).all({ model: cache.model, dims: cache.dims }).map((row) => row.id))
  for (const id of [...cache.ids]) if (!live.has(id)) removeRow(cache, id)
}

/** The n rows nearest the query by cosine distance, in the project when one is named; ties go to the higher id, as in the SQL scan. */
export function candidateIds(cache: SpaceCache, vector: Float32Array, project: string | null, n: number): number[] {
  let queryNorm = 0
  for (let j = 0; j < vector.length; j += 1) queryNorm += vector[j]! * vector[j]!
  queryNorm = Math.sqrt(queryNorm)
  if (queryNorm === 0 || n <= 0 || vector.length !== cache.dims) return []
  const { data, dims } = cache
  const scored: { id: number; distance: number }[] = []
  for (let row = 0; row < cache.count; row += 1) {
    const norm = cache.norms[row]!
    if (norm === 0 || (project !== null && cache.projects[row] !== project)) continue
    const base = row * dims
    let dot = 0
    for (let j = 0; j < dims; j += 1) dot += data[base + j]! * vector[j]!
    scored.push({ id: cache.ids[row]!, distance: 1 - dot / (norm * queryNorm) })
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
