// Messages between the daemon and its vector search worker (search-worker.ts).

import type { NearestQuery, VectorHit, VectorSpace } from '../store/vector-store'

export interface DistancesQuery {
  model: string
  vector: Float32Array
  project: string | null
  ids: readonly number[]
}

export interface WorkerStart {
  kind: 'start'
  dbPath: string
  dataDir: string
  /** The database key the daemon already holds; null for a plaintext store. */
  key: string | null
  /** The sqlite3mc library override the daemon was started with; null for the data folder's own build. */
  libraryOverride: string | null
  /** Page cache for the worker's connection, in KiB; null leaves SQLite's default. */
  cacheKib: number | null
  /** The space the daemon embeds in: its vectors load into memory right after the start. Null: on first search. */
  prewarm: VectorSpace | null
}

/** The indexer wrote these rows: the worker re-reads them into its vector cache. No reply. */
export interface WorkerChanged {
  kind: 'changed'
  ids: number[]
}

/** Rows may be gone (retention, purge, resolve): the worker drops its vector cache and reloads it. No reply. */
export interface WorkerInvalidate {
  kind: 'invalidate'
}

/** Closes the worker's connection; the worker answers `closed` and the daemon then ends it. */
export interface WorkerClose {
  kind: 'close'
}

export type WorkerRequest =
  | { kind: 'request'; id: number; deadlineAt: number; op: 'nearest'; query: NearestQuery }
  | { kind: 'request'; id: number; deadlineAt: number; op: 'distances'; query: DistancesQuery }

export type WorkerReply =
  | { kind: 'started'; ok: true }
  | { kind: 'started'; ok: false; reason: string }
  | { kind: 'hits'; id: number; hits: VectorHit[] }
  | { kind: 'expired'; id: number }
  | { kind: 'failed'; id: number; reason: string }
  | { kind: 'closed' }
