// Each embedding space's sqlite-vec index: a vec0 table, vec_space_<id>, in
// memory.db itself, so it is encrypted with the store. observation_vectors
// stays the record of every vector: it is written by plain SQL from any
// process, and redaction or purge removes rows there without sqlite-vec. The
// vec0 table is derived. The daemon writes it with each indexer batch and
// reconciles it in small chunks, and search only takes candidates from it.
// The exact distances and the filters come from observation_vectors, so a row
// the index has not caught up with yet never outranks what the store holds.
// A k-NN over 50,000 384-dim vectors takes about 25 ms (one project's
// partition about 1 ms), against a scan that read every vector row.

import type { Database } from '../sqlite/types'
import { spaceOf } from '../store/vector-spaces'
import { NO_FILTERS, type NearestQuery, type VectorHit, encodeVector, nearestObservations } from '../store/vector-store'

/** Candidates checked against the store per search: at least this many, and four for every hit asked for. */
export const MIN_CANDIDATES = 64
const CANDIDATES_PER_HIT = 4
/** A filtered search keeps fewer of its candidates, so it asks for more. */
const FILTERED_CANDIDATES_PER_HIT = 16
/** sqlite-vec refuses a larger k. */
export const MAX_KNN = 4096
/** Rows a reconcile pass inserts at most: about 90 ms of vec0 inserts for 1,000 rows on the daemon's thread. */
export const RECONCILE_CHUNK = 500
/** Deletes are cheaper and carry purged data, so a pass removes more of them. */
export const RECONCILE_REMOVE_CHUNK = 5_000

export interface IndexedSpace {
  id: number
  dims: number
  model: string
}

export interface VecRow {
  id: number
  project: string
  vector: Float32Array
}

const tableOf = (space: { id: number }): string => {
  if (!Number.isSafeInteger(space.id) || space.id <= 0) throw new Error('a vector space id must be a positive integer')
  return `vec_space_${space.id}`
}

export function vecIndexExists(db: Database, space: { id: number }): boolean {
  return db.query<{ n: number }, { name: string }>("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = $name").get({ name: tableOf(space) })!.n > 0
}

/** Needs sqlite-vec on this connection. */
export function createVecIndex(db: Database, space: IndexedSpace): void {
  if (!Number.isSafeInteger(space.dims) || space.dims <= 0) throw new Error('a vector space needs a positive length')
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableOf(space)} USING vec0(
    observation_id INTEGER PRIMARY KEY, project_key TEXT PARTITION KEY, embedding float[${space.dims}] distance_metric=cosine)`)
}

export function dropVecIndex(db: Database, space: { id: number }): void {
  db.run(`DROP TABLE IF EXISTS ${tableOf(space)}`)
}

/** Replaces each observation's row; one transaction. */
export function writeVecRows(db: Database, space: { id: number }, rows: readonly VecRow[]): void {
  if (rows.length === 0) return
  const table = tableOf(space)
  const remove = db.prepare(`DELETE FROM ${table} WHERE observation_id = $id`)
  const insert = db.prepare(`INSERT INTO ${table} (observation_id, project_key, embedding) VALUES ($id, $project, $embedding)`)
  db.transaction(() => {
    for (const row of rows) {
      remove.run({ id: row.id })
      insert.run({ id: row.id, project: row.project, embedding: encodeVector(row.vector) })
    }
  })()
}

export interface ReconcileResult {
  added: number
  removed: number
  /** Nothing was left over this pass. */
  done: boolean
}

/** Up to `limit` rows each way: index rows with no stored vector out, stored vectors with no index row in. */
export function reconcileVecIndex(db: Database, space: IndexedSpace, limit: number = RECONCILE_CHUNK): ReconcileResult {
  const table = tableOf(space)
  const params = { model: space.model, dims: space.dims, limit }
  const removeLimit = Math.max(limit, RECONCILE_REMOVE_CHUNK)
  const stale = db.query<{ id: number }, typeof params>(
    `SELECT observation_id AS id FROM ${table}
     WHERE observation_id NOT IN (SELECT observation_id FROM observation_vectors WHERE model = $model AND dims = $dims) LIMIT $limit`,
  ).all({ ...params, limit: removeLimit })
  // A row filed under a project its observation has left (a project merge or split, store/project-merge.ts) goes out, and comes back in below under the right one.
  const moved = db.query<{ id: number }, { limit: number }>(
    `SELECT v.observation_id AS id FROM ${table} v JOIN observations o ON o.id = v.observation_id WHERE v.project_key <> o.project_key LIMIT $limit`,
  ).all({ limit: removeLimit })
  stale.push(...moved.filter((row) => !stale.some((known) => known.id === row.id)))
  const remove = db.prepare(`DELETE FROM ${table} WHERE observation_id = $id`)
  const insert = db.prepare(`INSERT INTO ${table} (observation_id, project_key, embedding) VALUES ($id, $project, $embedding)`)
  // Read after the removals, so a row taken out for its project comes back in the same pass.
  const missing = db.transaction(() => {
    for (const row of stale) remove.run({ id: row.id })
    const rows = db.query<{ id: number; project: string; embedding: Uint8Array }, typeof params>(
      `SELECT v.observation_id AS id, o.project_key AS project, v.embedding AS embedding
       FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
       WHERE v.model = $model AND v.dims = $dims AND v.observation_id NOT IN (SELECT observation_id FROM ${table}) LIMIT $limit`,
    ).all(params)
    for (const row of rows) insert.run({ id: row.id, project: row.project, embedding: row.embedding })
    return rows
  })()
  return { added: missing.length, removed: stale.length, done: missing.length < limit && stale.length < removeLimit }
}

/** Observation ids nearest first; null project searches every partition. */
export function knnCandidates(db: Database, space: { id: number }, vector: Float32Array, project: string | null, k: number): number[] {
  const table = tableOf(space)
  const wanted = Math.max(1, Math.min(MAX_KNN, Math.trunc(k)))
  const embedding = encodeVector(vector)
  const rows = project === null
    ? db.query<{ id: number }, Record<string, number | Uint8Array>>(`SELECT observation_id AS id FROM ${table} WHERE embedding MATCH $embedding AND k = $k ORDER BY distance`).all({ embedding, k: wanted })
    : db.query<{ id: number }, Record<string, number | string | Uint8Array>>(`SELECT observation_id AS id FROM ${table} WHERE embedding MATCH $embedding AND k = $k AND project_key = $project ORDER BY distance`).all({ embedding, k: wanted, project })
  return rows.map((row) => row.id)
}

const hasFilters = (query: NearestQuery): boolean => {
  const filters = query.filters ?? NO_FILTERS
  return filters.type !== null || filters.host !== null || filters.evidence !== null
}

/**
 * The top k through the index: candidates from vec0, then the exact distance
 * and every filter from the store. A filtered search whose candidates ran out
 * before k matched scans in SQL instead, as before the index.
 */
export function vecNearest(db: Database, space: { id: number }, query: NearestQuery): VectorHit[] {
  const filtered = hasFilters(query)
  const want = Math.min(MAX_KNN, Math.max(MIN_CANDIDATES, query.k * (filtered ? FILTERED_CANDIDATES_PER_HIT : CANDIDATES_PER_HIT)))
  const ids = knnCandidates(db, space, query.vector, query.project, want)
  if (ids.length === 0) return []
  const filters = query.filters ?? NO_FILTERS
  const hits = db.query<VectorHit, Record<string, string | number | Uint8Array | null>>(
    `SELECT v.observation_id AS id, vec_distance_cosine(v.embedding, $vector) AS distance
     FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
     WHERE v.observation_id IN (SELECT value FROM json_each($ids)) AND v.model = $model AND v.dims = $dims
       AND ($project IS NULL OR o.project_key = $project)
       AND ($type IS NULL OR o.type = $type) AND ($host IS NULL OR o.host = $host)
       AND ($evidence IS NULL OR ($evidence = 'contradicted' AND o.contradicted_by IS NOT NULL) OR o.evidence = $evidence)
     ORDER BY distance, v.observation_id DESC LIMIT $k`,
  ).all({ vector: encodeVector(query.vector), ids: JSON.stringify(ids), model: query.model, dims: query.vector.length, project: query.project, k: query.k, ...filters })
  // Candidates the store no longer has (purged under the index) or that a filter dropped can leave fewer than k.
  if (hits.length < query.k && ids.length === want) return nearestObservations(db, query)
  return hits
}

/** Through the space's vec0 index when it holds every vector, else the SQL scan. */
export function nearestFor(db: Database, query: NearestQuery): VectorHit[] {
  const space = spaceOf(db, { model: query.model, dims: query.vector.length })
  if (space !== null && space.vecReady && vecIndexExists(db, space)) return vecNearest(db, space, query)
  return nearestObservations(db, query)
}
