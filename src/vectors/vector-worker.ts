// The daemon's side of the vector search worker (search-worker.ts). The scan
// runs there so the main thread keeps answering /health and hooks while a
// search reads cold pages. One worker, one query at a time, in order; a query
// past its limit answers null here at once, and the worker drops it unread if
// it has not started yet. A stopped worker makes every later query fail with a
// reason, which semantic search reports as unavailable.

import { isCompiledProgram } from '../runtime/program'
import type { Database } from '../sqlite/types'
import { type NearestQuery, type VectorHit, distancesFor, nearestObservations } from '../store/vector-store'
import type { DistancesQuery, WorkerReply, WorkerRequest, WorkerStart } from './vector-worker-protocol'

/** How long one vector read may take before the caller gets null. Cold reads of a large store take seconds. */
export const SEARCH_LIMIT_MS = 30_000

/**
 * The worker inside a compiled program. bun build --compile lays its entries
 * out from their common folder (src/, for src/cli/kinfold.ts and this worker),
 * and a Worker names an entry by that path, not by this module's own URL.
 * tools/build-release.test.ts holds the two in step.
 */
export const COMPILED_WORKER_PATH = './vectors/search-worker.ts'

function searchWorkerUrl(): string {
  return isCompiledProgram() ? COMPILED_WORKER_PATH : new URL('./search-worker.ts', import.meta.url).href
}

/** The two vector reads a semantic search makes. Null: the read ran past its limit. */
export interface VectorQueries {
  nearest(query: NearestQuery): Promise<VectorHit[] | null>
  distances(query: DistancesQuery): Promise<VectorHit[] | null>
  close(): void
}

/** The same reads on a connection the caller owns, on the caller's thread. */
export function inlineVectorQueries(db: Database): VectorQueries {
  return {
    nearest: async (query) => nearestObservations(db, query),
    distances: async (query) => distancesFor(db, query),
    close: () => {},
  }
}

/**
 * The worker once it has started, else `inline`: a worker that could not open
 * the store or load sqlite-vec is logged once and searches stay on the caller's
 * connection, as they were before the worker existed.
 */
export function workerOrInline(starting: Promise<VectorWorkerStart>, inline: VectorQueries, log: (line: string) => void): VectorQueries {
  const ready = starting.then((started) => {
    if (started.ok) return started.queries
    log(`vectors search worker off (${started.reason}); searching on the daemon connection`)
    return inline
  })
  let closed = false
  return {
    nearest: async (query) => (await ready).nearest(query),
    distances: async (query) => (await ready).distances(query),
    close: () => {
      if (closed) return
      closed = true
      void ready.then((queries) => queries.close())
    },
  }
}

export interface VectorWorkerOptions extends Omit<WorkerStart, 'kind'> {
  limitMs?: number
  /** The worker script; tests pass their own. */
  workerUrl?: string
}

export type VectorWorkerStart = { ok: true; queries: VectorQueries } | { ok: false; reason: string }

interface Pending {
  resolve: (hits: VectorHit[] | null) => void
  reject: (error: Error) => void
  timer: Timer
}

export async function startVectorWorker(options: VectorWorkerOptions): Promise<VectorWorkerStart> {
  const limitMs = options.limitMs ?? SEARCH_LIMIT_MS
  const worker = new Worker(options.workerUrl ?? searchWorkerUrl())
  const pending = new Map<number, Pending>()
  let nextId = 1
  let stopped: string | null = null
  let started: ((reply: WorkerReply) => void) | null = null

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      pending.delete(id)
    }
    return entry
  }
  const stop = (reason: string): void => {
    stopped ??= reason
    for (const id of [...pending.keys()]) settle(id)?.reject(new Error(reason))
  }

  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data
    if (reply.kind === 'started') {
      started?.(reply)
      return
    }
    const entry = settle(reply.id)
    if (reply.kind === 'hits') entry?.resolve(reply.hits)
    else if (reply.kind === 'expired') entry?.resolve(null)
    else entry?.reject(new Error(reply.reason))
  }
  worker.onerror = (event: ErrorEvent) => {
    stop(`the search worker stopped (${event.message.slice(0, 120)})`)
    started?.({ kind: 'started', ok: false, reason: 'the search worker stopped while starting' })
  }

  const reply = await new Promise<WorkerReply>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'started', ok: false, reason: `the search worker did not start within ${limitMs} ms` }), limitMs)
    started = (message) => {
      clearTimeout(timer)
      started = null
      resolve(message)
    }
    const start: WorkerStart = {
      kind: 'start', dbPath: options.dbPath, dataDir: options.dataDir, key: options.key, libraryOverride: options.libraryOverride, cacheKib: options.cacheKib,
    }
    worker.postMessage(start)
  })
  if (reply.kind !== 'started' || !reply.ok) {
    worker.terminate()
    return { ok: false, reason: reply.kind === 'started' && !reply.ok ? reply.reason : 'the search worker did not start' }
  }

  const ask = (request: Omit<WorkerRequest, 'kind' | 'id' | 'deadlineAt'>): Promise<VectorHit[] | null> => {
    if (stopped !== null) return Promise.reject(new Error(stopped))
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(id)?.resolve(null), limitMs)
      pending.set(id, { resolve, reject, timer })
      worker.postMessage({ ...request, kind: 'request', id, deadlineAt: Date.now() + limitMs } as WorkerRequest)
    })
  }

  return {
    ok: true,
    queries: {
      nearest: (query) => ask({ op: 'nearest', query }),
      distances: (query) => ask({ op: 'distances', query }),
      close: () => {
        stop('the search worker was closed')
        worker.terminate()
      },
    },
  }
}
