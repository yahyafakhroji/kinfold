// The checkpoint worker: one writable connection to memory.db on a thread of
// its own, copying the WAL into the store when the daemon asks. The daemon's
// connection never checkpoints while this worker runs (wal_autocheckpoint 0),
// because a checkpoint ends with a sync of the whole store file, and on a large
// store (Windows above all) that sync held the thread that answers hooks for
// seconds. Opened the way the store readers open theirs: the key comes in the
// start message and stays in memory.

import { existsSync } from 'node:fs'
import { openStoreFile } from '../sqlite/open'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import type { Database } from '../sqlite/types'
import type { CheckpointMessage, CheckpointReply, CheckpointRequest, CheckpointResult, CheckpointStart } from './checkpoint-protocol'

declare const self: Worker

/** The key check at open reads the file; a writer holding it must be waited for there, and only there. */
const OPEN_BUSY_TIMEOUT_MS = 5_000

let db: Database | null = null

function start(message: CheckpointStart): CheckpointReply {
  try {
    // A checkpoint is of a store that exists: never create one.
    if (!existsSync(message.dbPath)) return { kind: 'started', ok: false, reason: 'memory.db does not exist' }
    const key = message.key
    const keys = { name: "daemon's key store", read: () => key, exists: () => key !== null }
    const env = message.libraryOverride === null ? {} : { [SQLITE3MC_LIB_ENV]: message.libraryOverride }
    db = openStoreFile(message.dbPath, { keys, env, busyTimeoutMs: OPEN_BUSY_TIMEOUT_MS })
    // A checkpoint that meets the daemon's writer or a reader stops at once and reports busy; the next turn goes on.
    db.run('PRAGMA busy_timeout = 0')
    db.run('PRAGMA wal_autocheckpoint = 0')
    return { kind: 'started', ok: true }
  } catch (error: unknown) {
    db?.close()
    db = null
    return { kind: 'started', ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'the worker could not open the store' }
  }
}

function checkpoint(message: CheckpointRequest): CheckpointReply {
  if (db === null) return { kind: 'failed', id: message.id, reason: 'the checkpoint worker has no open store' }
  try {
    const row = db.query<CheckpointResult, []>(`PRAGMA wal_checkpoint(${message.mode === 'TRUNCATE' ? 'TRUNCATE' : 'PASSIVE'})`).get()
    return { kind: 'done', id: message.id, result: row ?? { busy: 1, log: -1, checkpointed: -1 } }
  } catch (error: unknown) {
    return { kind: 'failed', id: message.id, reason: error instanceof Error ? error.message.slice(0, 160) : 'the checkpoint failed' }
  }
}

self.onmessage = (event: MessageEvent<CheckpointMessage>) => {
  const message = event.data
  switch (message.kind) {
    case 'close':
      db?.close()
      db = null
      postMessage({ kind: 'closed' } satisfies CheckpointReply)
      return
    case 'start':
      postMessage(start(message))
      return
    default:
      postMessage(checkpoint(message))
  }
}
