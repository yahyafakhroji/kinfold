// The nearest-vector scan, off the daemon's main thread. A search reads every
// vector of the model, about one page per observation, and on a cold encrypted
// store that took the daemon's only thread for tens of seconds: /health and
// every hook waited behind it. This worker holds its own read-only connection
// with sqlite-vec loaded and answers one query at a time. An unfiltered nearest
// read ranks a 16-bit copy of the model's vectors in memory (vector-cache.ts)
// and takes exact distances for its candidates from the store; a filtered one
// scans in SQL as before. It gets the store key in its start message
// (in-process memory only) and never reads a key store, the environment or
// anything outside the data folder. Query vectors and hits are never logged.

import type { Database } from '../sqlite/types'
import { openStoreFile } from '../sqlite/open'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { type VectorSpace, distancesFor, nearestObservations } from '../store/vector-store'
import { loadVec0 } from './extension'
import { type SpaceCache, cachedNearest, hasFilters, loadSpaceCache, pruneCache, refreshCacheRows } from './vector-cache'
import type { WorkerChanged, WorkerClose, WorkerInvalidate, WorkerReply, WorkerRequest, WorkerStart } from './vector-worker-protocol'

declare const self: Worker

const OPEN_BUSY_TIMEOUT_MS = 5_000

let db: Database | null = null
const caches = new Map<string, SpaceCache>()
const keyOf = (space: VectorSpace): string => `${space.dims}:${space.model}`

function cacheFor(open: Database, space: VectorSpace): SpaceCache {
  const key = keyOf(space)
  let cache = caches.get(key)
  if (cache === undefined) {
    // One space at a time: the embedder's model is fixed for a daemon's life, and an old one is never searched again.
    caches.clear()
    cache = loadSpaceCache(open, space)
    caches.set(key, cache)
  }
  return cache
}

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
    const query = message.query
    const hits = hasFilters(query.filters)
      ? nearestObservations(db, query)
      : cachedNearest(db, cacheFor(db, { model: query.model, dims: query.vector.length }), query)
    return { kind: 'hits', id: message.id, hits }
  } catch (error: unknown) {
    return { kind: 'failed', id: message.id, reason: error instanceof Error ? error.message.slice(0, 160) : 'the search failed' }
  }
}

/**
 * Cache upkeep never fails a search: on an error the cache is dropped and the
 * next search loads it again. It always answers `upkept`, because the daemon
 * counts upkeep as a read of the store until then.
 */
function upkeep(work: (open: Database) => number | void): void {
  const reply: WorkerReply & { kind: 'upkept' } = { kind: 'upkept' }
  try {
    const rows = db === null ? undefined : work(db)
    if (typeof rows === 'number') reply.rows = rows
  } catch (error: unknown) {
    caches.clear()
    reply.error = error instanceof Error ? error.name : 'error'
  }
  postMessage(reply)
}

self.onmessage = (event: MessageEvent<WorkerStart | WorkerRequest | WorkerClose | WorkerChanged | WorkerInvalidate>) => {
  const message = event.data
  switch (message.kind) {
    case 'close':
      caches.clear()
      db?.close()
      db = null
      postMessage({ kind: 'closed' } satisfies WorkerReply)
      return
    case 'changed':
      upkeep((open) => {
        for (const cache of caches.values()) refreshCacheRows(open, cache, message.ids)
      })
      return
    case 'invalidate':
      upkeep((open) => {
        for (const cache of caches.values()) pruneCache(open, cache)
      })
      return
    case 'start': {
      const reply = start(message)
      postMessage(reply)
      if (reply.kind === 'started' && reply.ok && message.prewarm !== null) {
        const space = message.prewarm
        upkeep((open) => cacheFor(open, space).count)
      }
      return
    }
    default:
      postMessage(answer(message))
  }
}
