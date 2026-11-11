// Rows of observation_vectors (v8). Writes and the queue are plain SQL,
// so they work on any connection; only nearestObservations calls sqlite-vec's
// vec_distance_cosine and needs the extension loaded (src/vectors/extension.ts).
// The search filters by project before it measures distance (project
// filter first), so its cost grows with one project's rows, not the store's.
// Nothing here logs or returns observation text except embeddingInputs, whose
// caller sends it to the embedder and nowhere else.

import type { Database } from '../sqlite/types'

/** text-embedding-3-small accepts 8191 tokens; at about 4 chars a token this stays under it. */
export const MAX_EMBED_CHARS = 8_000

export interface EmbeddingInput {
  id: number
  /** observations.content_hash when the text was read; the write must see the same one. */
  contentHash: string
  text: string
}

export interface StoredVector {
  id: number
  contentHash: string
  vector: Float32Array
}

/** The embedder a row must come from to count: same model, same length. */
export interface VectorSpace {
  model: string
  dims: number
}

export interface VectorHit {
  id: number
  /** Cosine distance: 0 is the same direction, 2 the opposite. */
  distance: number
}

export interface VectorCounts {
  /** Observations with a vector from the current model. */
  indexed: number
  /** Observations with no vector, or one from another model. */
  pending: number
}

/** The bytes sqlite-vec reads as float[N]: float32 in the platform's order, little-endian on every Mac Bun runs on. */
export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength))
}

export function decodeVector(bytes: Uint8Array): Float32Array {
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
}

function facts(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

/** Title, narrative and facts: the text the observer wrote, already redacted at the edge. */
export function embeddingText(row: { title: string; narrative: string; facts: string }): string {
  const text = [row.title, row.narrative, ...facts(row.facts)].map((part) => part.trim()).filter((part) => part !== '').join('\n')
  return text.length <= MAX_EMBED_CHARS ? text : text.slice(0, MAX_EMBED_CHARS)
}

/**
 * Ids of observations with no vector in this model and length: a missing
 * vector or one from another model or dims. Only indexes are read: a covering
 * index of observations for the ids, and observation_vectors_by_space once for
 * the embedded set (observation_id is the primary key, never NULL, so NOT IN
 * is safe). Joining each observation to its vector row instead costs a page
 * per observation, because each vector row carries its embedding, and the
 * indexer asks every few seconds even when nothing is left to embed.
 */
const BACKLOG_IDS = `SELECT o.id FROM observations o WHERE o.id NOT IN (
  SELECT observation_id FROM observation_vectors WHERE model = $model AND dims = $dims)`

// `+o.id` keeps SQLite from walking the observations table in id order to
// meet the ORDER BY: the backlog is sorted in a temp tree, and it is small.
export const EMBEDDING_INPUTS_SQL = `SELECT o.id, o.content_hash AS contentHash, o.title, o.narrative, o.facts
  FROM observations o WHERE o.id IN (${BACKLOG_IDS} ORDER BY +o.id DESC LIMIT $limit) ORDER BY o.id DESC`
export const INDEXED_COUNT_SQL = 'SELECT count(*) AS n FROM observation_vectors WHERE model = $model AND dims = $dims'
export const PENDING_COUNT_SQL = `SELECT count(*) AS n FROM (${BACKLOG_IDS})`

/** Newest first, so what an agent just learned is searchable soonest. */
export function embeddingInputs(db: Database, space: VectorSpace, limit: number): EmbeddingInput[] {
  const rows = db.query<{ id: number; contentHash: string; title: string; narrative: string; facts: string }, Record<string, string | number>>(EMBEDDING_INPUTS_SQL)
    .all({ ...space, limit })
  return rows.map((row) => ({ id: row.id, contentHash: row.contentHash, text: embeddingText(row) }))
}

export function vectorCounts(db: Database, space: VectorSpace): VectorCounts {
  const indexed = db.query<{ n: number }, Record<string, string | number>>(INDEXED_COUNT_SQL).get({ ...space })?.n ?? 0
  const pending = db.query<{ n: number }, Record<string, string | number>>(PENDING_COUNT_SQL).get({ ...space })?.n ?? 0
  return { indexed, pending }
}

/**
 * One transaction. A row is written only onto the observation whose text it
 * came from: same id and the content_hash read with the text. observations.id
 * is reused after the newest row is purged, so the id alone could put a
 * purged text's vector on a new observation. A row purged while its batch
 * was at the embedder is skipped. Returns how many rows were written.
 */
export function upsertVectors(db: Database, model: string, vectors: readonly StoredVector[], now: number): number {
  const statement = db.prepare(
    `INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at)
     SELECT id, $model, $dims, $embedding, $now FROM observations WHERE id = $id AND content_hash = $contentHash
     ON CONFLICT (observation_id) DO UPDATE SET model = excluded.model, dims = excluded.dims,
       embedding = excluded.embedding, created_at = excluded.created_at`,
  )
  return db.transaction(() => vectors.reduce((written, { id, contentHash, vector }) => {
    const result = statement.run({ id, contentHash, model, dims: vector.length, embedding: encodeVector(vector), now })
    return written + result.changes
  }, 0))()
}

/** The MCP search filters; null is "any". Applied before the top k, so a filter never empties the vector list. */
export interface NearestFilters {
  type: string | null
  host: string | null
  /** An evidence strength, or 'contradicted' for rows another one disproves. */
  evidence: string | null
}

export const NO_FILTERS: NearestFilters = { type: null, host: null, evidence: null }

export interface NearestQuery {
  model: string
  vector: Float32Array
  /** Null searches every project. */
  project: string | null
  k: number
  filters?: NearestFilters
}

/** At most this many ids get a distance outside the top k; the prompt path asks for its keyword candidates. */
export const MAX_DISTANCE_IDS = 50

/**
 * The query's distance to the named rows in the project (the current model
 * only), whether or not they made the top k: so a keyword match outside the
 * nearest k still has a distance the gate can veto on.
 */
export function distancesFor(db: Database, query: { model: string; vector: Float32Array; project: string | null; ids: readonly number[] }): VectorHit[] {
  const ids = query.ids.slice(0, MAX_DISTANCE_IDS)
  if (ids.length === 0) return []
  return db.query<VectorHit, Record<string, string | number | Uint8Array | null>>(
    `SELECT v.observation_id AS id, vec_distance_cosine(v.embedding, $vector) AS distance
     FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
     WHERE v.observation_id IN (SELECT value FROM json_each($ids))
       AND ($project IS NULL OR o.project_key = $project) AND v.model = $model AND v.dims = $dims
     ORDER BY distance, v.observation_id DESC`,
  ).all({ vector: encodeVector(query.vector), project: query.project, model: query.model, dims: query.vector.length, ids: JSON.stringify(ids) })
}

/** Needs sqlite-vec on this connection; throws "no such function" without it. */
export function nearestObservations(db: Database, query: NearestQuery): VectorHit[] {
  const filters = query.filters ?? NO_FILTERS
  return db.query<VectorHit, Record<string, string | number | Uint8Array | null>>(
    `SELECT v.observation_id AS id, vec_distance_cosine(v.embedding, $vector) AS distance
     FROM observation_vectors v JOIN observations o ON o.id = v.observation_id
     WHERE ($project IS NULL OR o.project_key = $project) AND v.model = $model AND v.dims = $dims
       AND ($type IS NULL OR o.type = $type) AND ($host IS NULL OR o.host = $host)
       AND ($evidence IS NULL OR ($evidence = 'contradicted' AND o.contradicted_by IS NOT NULL) OR o.evidence = $evidence)
     ORDER BY distance, v.observation_id DESC LIMIT $k`,
  ).all({ vector: encodeVector(query.vector), project: query.project, model: query.model, dims: query.vector.length, k: query.k, ...filters })
}
