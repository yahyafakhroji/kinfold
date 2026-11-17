// Messages between the daemon and a store reader worker (store-reader-worker.ts).

export interface StoreReaderStart {
  kind: 'start'
  dbPath: string
  dataDir: string
  /** The database key the daemon already holds; null for a plaintext store. */
  key: string | null
  /** The sqlite3mc library override the daemon was started with; null for the data folder's own build. */
  libraryOverride: string | null
  /** Page cache for the worker's connection, in KiB; null leaves SQLite's default. */
  cacheKib: number | null
}

export interface StoreReaderRequest {
  kind: 'request'
  id: number
  /** Epoch ms past which the worker skips the read unrun: its caller has stopped waiting. */
  expireAt: number
  op: string
  args: unknown
}

/** Closes the worker's connection; the worker answers `closed` and the daemon then ends it. */
export interface StoreReaderClose {
  kind: 'close'
}

export type StoreReaderMessage = StoreReaderStart | StoreReaderRequest | StoreReaderClose

export type StoreReaderReply =
  | { kind: 'started'; ok: true }
  | { kind: 'started'; ok: false; reason: string }
  | { kind: 'answer'; id: number; value: unknown }
  | { kind: 'expired'; id: number }
  | { kind: 'failed'; id: number; reason: string }
  | { kind: 'closed' }
