// A consistent copy of memory.db while it is in use. `VACUUM INTO` reads the
// store inside one read transaction, so the copy is the store at a single
// moment even while the daemon keeps committing, and sqlite3mc writes it with
// the source's cipher and key: an encrypted store gives an encrypted snapshot
// that opens with the same key. The copy is one file in rollback-journal mode
// (no WAL beside it) and keeps user_version.
//
// The daemon runs the copy in a worker on its own read-only connection, so a
// large store does not hold the thread that answers hooks; the command line
// runs it inline when the daemon is down.

import { chmodSync, existsSync, rmSync } from 'node:fs'
import { isCompiledProgram } from '../runtime/program'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { maintenancePath, openEncrypted, openPlain } from '../sqlite/open'
import type { Database } from '../sqlite/types'
import { DATA_FILE_MODE } from '../store/data-dir'
import { BackupError } from './archive'

/** The copy waits this long on a writer's lock before failing. */
const OPEN_BUSY_TIMEOUT_MS = 5_000

/**
 * The worker inside a compiled program: named by its path from the entries'
 * common folder (src/), as the search worker is. tools/build-release.test.ts
 * holds the two in step.
 */
export const COMPILED_SNAPSHOT_WORKER_PATH = './backup/snapshot-worker.ts'

export interface SnapshotFileInput {
  dbPath: string
  /** The store's key; null for a plaintext store. Stays in this process. */
  key: string | null
  dest: string
  env?: Readonly<Record<string, string | undefined>>
}

export interface SnapshotWorkerInput {
  dbPath: string
  key: string | null
  dest: string
  /** The sqlite3mc library the parent process uses, when it was named by the environment. */
  libraryOverride: string | null
  /** The worker script; tests pass their own. */
  workerUrl?: string
}

export type SnapshotWorkerReply = { ok: true } | { ok: false; reason: string }

/** Copies the open store to a new file. `dest` must not exist; a failed copy leaves nothing behind. */
export function snapshotInto(db: Database, dest: string): void {
  if (existsSync(dest)) throw new BackupError('state', 'the snapshot file exists already')
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
    chmodSync(dest, DATA_FILE_MODE)
  } catch (error: unknown) {
    rmSync(dest, { force: true })
    throw error
  }
}

/** The same copy through a read-only connection of its own, for a process that does not hold the store open. */
export function snapshotStoreFile(input: SnapshotFileInput): void {
  if (existsSync(maintenancePath(input.dbPath))) throw new BackupError('busy', 'memory.db is being changed (kinfold encrypt, decrypt, rekey or restore); try again when it finishes')
  const options = { readonly: true, busyTimeoutMs: OPEN_BUSY_TIMEOUT_MS }
  const db = input.key === null ? openPlain(input.dbPath, options, input.env) : openEncrypted(input.dbPath, input.key, options, input.env)
  try {
    snapshotInto(db, input.dest)
  } finally {
    db.close()
  }
}

function workerUrl(): string {
  return isCompiledProgram() ? COMPILED_SNAPSHOT_WORKER_PATH : new URL('./snapshot-worker.ts', import.meta.url).href
}

/** The environment the worker opens the library with: the parent's override only, never the whole environment. */
export function workerEnv(libraryOverride: string | null): Readonly<Record<string, string | undefined>> {
  return libraryOverride === null ? {} : { [SQLITE3MC_LIB_ENV]: libraryOverride }
}

/** Runs snapshotStoreFile in a one-shot worker. Rejects with the worker's fixed reason, which never holds the key. */
export function snapshotInWorker(input: SnapshotWorkerInput): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(input.workerUrl ?? workerUrl())
    const finish = (error: Error | null): void => {
      worker.terminate()
      if (error === null) resolve()
      else reject(error)
    }
    worker.onmessage = (event: MessageEvent<SnapshotWorkerReply>) => {
      finish(event.data.ok ? null : new Error(event.data.reason))
    }
    // The event's own message can quote a path; the fixed text is enough.
    worker.onerror = () => finish(new Error('the snapshot worker failed'))
    worker.postMessage({ dbPath: input.dbPath, key: input.key, dest: input.dest, libraryOverride: input.libraryOverride })
  })
}
