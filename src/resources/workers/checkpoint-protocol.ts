// Messages between the daemon and its checkpoint worker (checkpoint-worker.ts).

export interface CheckpointStart {
  kind: 'start'
  dbPath: string
  /** The database key the daemon already holds; null for a plaintext store. */
  key: string | null
  /** The sqlite3mc library override the daemon was started with; null for the data folder's own build. */
  libraryOverride: string | null
}

export type CheckpointMode = 'PASSIVE' | 'TRUNCATE'

export interface CheckpointRequest {
  kind: 'checkpoint'
  id: number
  mode: CheckpointMode
}

/** Closes the worker's connection; the worker answers `closed` and the daemon then ends it. */
export interface CheckpointClose {
  kind: 'close'
}

export type CheckpointMessage = CheckpointStart | CheckpointRequest | CheckpointClose

/** What `PRAGMA wal_checkpoint` reports: whether it was kept from finishing, frames in the WAL, frames now in the store. */
export interface CheckpointResult {
  busy: number
  log: number
  checkpointed: number
}

export type CheckpointReply =
  | { kind: 'started'; ok: true }
  | { kind: 'started'; ok: false; reason: string }
  | { kind: 'done'; id: number; result: CheckpointResult }
  | { kind: 'failed'; id: number; reason: string }
  | { kind: 'closed' }
