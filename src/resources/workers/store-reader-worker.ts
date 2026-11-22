// A store reader worker: one read-only connection to memory.db on a thread of
// its own, running the reads in store-reads.ts by name, one at a time. Opened
// the way the vector search worker opens its connection: the store key comes
// in the start message (in-process memory only) and nothing outside the data
// folder is read. Arguments and answers are never logged.

import { openStoreFile } from '../sqlite/open'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import type { Database } from '../sqlite/types'
import type { StoreReaderMessage, StoreReaderReply, StoreReaderRequest, StoreReaderStart } from './store-reader-protocol'
import { isStoreRead, runStoreRead } from './store-reads'

declare const self: Worker

const OPEN_BUSY_TIMEOUT_MS = 5_000

let db: Database | null = null
let dbPath = ''

function start(message: StoreReaderStart): StoreReaderReply {
  try {
    const key = message.key
    const keys = { name: "daemon's key store", read: () => key, exists: () => key !== null }
    const env = message.libraryOverride === null ? {} : { [SQLITE3MC_LIB_ENV]: message.libraryOverride }
    // The daemon writes and checkpoints beside this reader; a WAL recovery at open must wait, not fail the start.
    db = openStoreFile(message.dbPath, { readonly: true, keys, env, busyTimeoutMs: OPEN_BUSY_TIMEOUT_MS })
    if (message.cacheKib !== null) db.run(`PRAGMA cache_size = -${Math.trunc(message.cacheKib)}`)
    dbPath = message.dbPath
    return { kind: 'started', ok: true }
  } catch (error: unknown) {
    db?.close()
    db = null
    return { kind: 'started', ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'the worker could not open the store' }
  }
}

function answer(message: StoreReaderRequest): StoreReaderReply {
  if (db === null) return { kind: 'failed', id: message.id, reason: 'the store reader has no open store' }
  if (Date.now() > message.expireAt) return { kind: 'expired', id: message.id }
  if (!isStoreRead(message.op)) return { kind: 'failed', id: message.id, reason: 'no such read' }
  try {
    return { kind: 'answer', id: message.id, value: runStoreRead(db, dbPath, message.op, message.args) }
  } catch (error: unknown) {
    return { kind: 'failed', id: message.id, reason: error instanceof Error ? error.message.slice(0, 160) : 'the read failed' }
  }
}

self.onmessage = (event: MessageEvent<StoreReaderMessage>) => {
  const message = event.data
  switch (message.kind) {
    case 'close':
      db?.close()
      db = null
      postMessage({ kind: 'closed' } satisfies StoreReaderReply)
      return
    case 'start':
      postMessage(start(message))
      return
    default:
      postMessage(answer(message))
  }
}
