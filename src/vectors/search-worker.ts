// Vector reads, off the daemon's main thread. A search on a cold encrypted
// store once held the daemon's only thread for seconds, and /health and every
// hook waited behind it. This worker holds its own read-only connection with
// sqlite-vec loaded and answers one query at a time. A space whose vec0 index
// is ready is searched through it (vec-index.ts); one still being indexed is
// scanned in SQL, as before the index. It gets the store key in its start
// message (in-process memory only) and never reads a key store, the
// environment or anything outside the data folder. Query vectors and hits are
// never logged.

import type { Database } from '../sqlite/types'
import { openStoreFile } from '../sqlite/open'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { distancesFor } from '../store/vector-store'
import { loadVec0 } from './extension'
import { nearestFor } from './vec-index'
import type { WorkerClose, WorkerReply, WorkerRequest, WorkerStart } from './vector-worker-protocol'

declare const self: Worker

const OPEN_BUSY_TIMEOUT_MS = 5_000

let db: Database | null = null

function start(message: WorkerStart): WorkerReply {
  try {
    const key = message.key
    const keys = { name: "daemon's key store", read: () => key, exists: () => key !== null }
    const env = message.libraryOverride === null ? {} : { [SQLITE3MC_LIB_ENV]: message.libraryOverride }
    // The daemon writes and checkpoints beside this reader; a WAL recovery at open must wait, not fail the start.
    db = openStoreFile(message.dbPath, { readonly: true, keys, env, busyTimeoutMs: OPEN_BUSY_TIMEOUT_MS })
    // Vector pages stay decrypted here between searches, as the daemon's own connection keeps its pages.
    if (message.cacheKib !== null) db.run(`PRAGMA cache_size = -${Math.trunc(message.cacheKib)}`)
    const support = loadVec0(db, message.dataDir)
    if (!support.ok) {
      db.close()
      db = null
      return { kind: 'started', ok: false, reason: support.reason }
    }
    return { kind: 'started', ok: true }
  } catch (error: unknown) {
    db?.close()
    db = null
    return { kind: 'started', ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'the worker could not open the store' }
  }
}

function answer(message: WorkerRequest): WorkerReply {
  if (db === null) return { kind: 'failed', id: message.id, reason: 'the search worker has no open store' }
  // A request whose caller already gave up costs a scan for nothing.
  if (Date.now() > message.deadlineAt) return { kind: 'expired', id: message.id }
  try {
    if (message.op === 'distances') return { kind: 'hits', id: message.id, hits: distancesFor(db, message.query) }
    return { kind: 'hits', id: message.id, hits: nearestFor(db, message.query) }
  } catch (error: unknown) {
    return { kind: 'failed', id: message.id, reason: error instanceof Error ? error.message.slice(0, 160) : 'the search failed' }
  }
}

self.onmessage = (event: MessageEvent<WorkerStart | WorkerRequest | WorkerClose>) => {
  const message = event.data
  switch (message.kind) {
    case 'close':
      db?.close()
      db = null
      postMessage({ kind: 'closed' } satisfies WorkerReply)
      return
    case 'start':
      postMessage(start(message))
      return
    default:
      postMessage(answer(message))
  }
}
