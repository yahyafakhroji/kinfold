// The daemon's side of the vector search worker (search-worker.ts). The scan
// runs there so the main thread keeps answering /health and hooks while a
// search reads cold pages. One worker, one query at a time, in order. A query
// past its budget answers null here at once, and the worker drops it unread
// if it has not started yet. A stopped worker makes every later query fail
// with a reason; workerOrInline then moves searches back to the daemon's own
// connection.

import { isCompiledProgram } from '../runtime/program'
import type { Database } from '../sqlite/types'
import { type NearestQuery, type VectorHit, distancesFor, nearestObservations } from '../store/vector-store'
import type { DistancesQuery, WorkerReply, WorkerRequest, WorkerStart } from './vector-worker-protocol'

/** How long one vector read may take before the caller gets null. Cold reads of a large store take seconds. */
export const SEARCH_LIMIT_MS = 30_000
/** How long close waits for the worker to close its connection before ending it anyway. */
export const CLOSE_WAIT_MS = 2_000

/**
 * The worker inside a compiled program. bun build --compile lays its entries
 * out from their common folder (src/, for src/cli/kinfold.ts and this worker),
 * and a Worker names an entry by that path, not by this module's own URL.
 * tools/build-release.test.ts holds the two in step.
 */
export const COMPILED_WORKER_PATH = './vectors/search-worker.ts'

/**
 * Runs fn once no vector read holds a snapshot of the store, holding new reads
 * until it returns. fn must be synchronous: the gate reopens when it returns.
 */
export type Exclusive = <T>(fn: () => T) => Promise<T>

/** For callers with no worker: fn runs at once, before the promise is returned. */
export const runNow: Exclusive = async (fn) => fn()

/** The two vector reads a semantic search makes. Null: the read ran past its budget. */
export interface VectorQueries {
  /** giveUpMs: the caller stops waiting then; the worker skips the read if it has not started it. */
  nearest(query: NearestQuery, giveUpMs?: number): Promise<VectorHit[] | null>
  distances(query: DistancesQuery, giveUpMs?: number): Promise<VectorHit[] | null>
  /**
   * For work that must not run beside an open read snapshot: retention,
   * purge and resolve finish with a TRUNCATE checkpoint, which waits for
   * every reader to leave the WAL, and a cold scan holds its snapshot for
   * seconds.
   */
  exclusive: Exclusive
  close(): void
}

/** The same reads on a connection the caller owns, on the caller's thread. */
export function inlineVectorQueries(db: Database): VectorQueries {
  return {
    nearest: async (query) => nearestObservations(db, query),
    distances: async (query) => distancesFor(db, query),
    exclusive: runNow,
    close: () => {},
  }
}

function searchWorkerUrl(): string {
  return isCompiledProgram() ? COMPILED_WORKER_PATH : new URL('./search-worker.ts', import.meta.url).href
}

const STOPPED_PREFIX = 'the search worker stopped'

/**
 * The worker once it has started, else `inline`. A worker that could not
 * start, or stops later, is logged once and searches go back to the caller's
 * connection, as they were before the worker existed.
 */
export function workerOrInline(starting: Promise<VectorWorkerStart>, inline: VectorQueries, log: (line: string) => void): VectorQueries {
  let current: VectorQueries | null = null
  const ready = starting
    .then((started) => {
      if (started.ok) return started.queries
      log(`vectors search worker off (${started.reason}); searching on the daemon connection`)
      return inline
    })
    .catch((error: unknown) => {
      log(`vectors search worker off (${error instanceof Error ? error.message : 'it failed to start'}); searching on the daemon connection`)
      return inline
    })
    .then((queries) => {
      current = queries
      return queries
    })
  const onStopped = (error: unknown): VectorQueries => {
    if (!(error instanceof Error) || !error.message.startsWith(STOPPED_PREFIX)) throw error
    // Every read in flight when the worker stopped falls back; only the first one logs and closes it.
    if (current !== inline) {
      log(`vectors ${error.message}; searching on the daemon connection`)
      current?.close()
      current = inline
    }
    return inline
  }
  const read = async (run: (queries: VectorQueries) => Promise<VectorHit[] | null>): Promise<VectorHit[] | null> => {
    const queries = current ?? (await ready)
    try {
      return await run(queries)
    } catch (error: unknown) {
      return run(onStopped(error))
    }
  }
  let closed = false
  return {
    nearest: (query, giveUpMs) => read((queries) => queries.nearest(query, giveUpMs)),
    distances: (query, giveUpMs) => read((queries) => queries.distances(query, giveUpMs)),
    exclusive: async (fn) => (current ?? (await ready)).exclusive(fn),
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
  let closed: (() => void) | null = null
  let closing = false
  // Reads posted to the worker and not yet answered by it, including ones the caller stopped waiting for.
  let inWorker = 0
  let idleWaiters: (() => void)[] = []
  // While an exclusive call waits or runs, new reads wait here instead of reaching the worker.
  let held: (() => void)[] = []
  let gate: Promise<unknown> = Promise.resolve()
  let gated = false
  let exclusives = 0

  const settle = (id: number): Pending | undefined => {
    const entry = pending.get(id)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      pending.delete(id)
    }
    return entry
  }
  const wakeIdle = (): void => {
    if (inWorker > 0) return
    for (const wake of idleWaiters.splice(0)) wake()
  }
  const stop = (reason: string): void => {
    stopped ??= reason
    for (const id of [...pending.keys()]) settle(id)?.reject(new Error(stopped))
    inWorker = 0
    wakeIdle()
    for (const post of held.splice(0)) post()
  }

  worker.onmessage = (event: MessageEvent<WorkerReply>) => {
    const reply = event.data
    if (reply.kind === 'started') {
      started?.(reply)
      return
    }
    if (reply.kind === 'closed') {
      closed?.()
      return
    }
    inWorker = Math.max(0, inWorker - 1)
    const entry = settle(reply.id)
    if (reply.kind === 'hits') entry?.resolve(reply.hits)
    else if (reply.kind === 'expired') entry?.resolve(null)
    else entry?.reject(new Error(reply.reason))
    wakeIdle()
  }
  const ended = (why: string): void => {
    stop(`${STOPPED_PREFIX} (${why})`)
    started?.({ kind: 'started', ok: false, reason: 'the search worker stopped while starting' })
    closed?.()
  }
  worker.onerror = (event: ErrorEvent) => ended(event.message.slice(0, 120))
  // An exit with no error event would otherwise leave reads counted in the worker and exclusive waiting forever.
  worker.addEventListener('close', () => {
    if (!closing) ended('it exited')
  })

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

  const ask = (request: Omit<WorkerRequest, 'kind' | 'id' | 'deadlineAt'>, giveUpMs: number | undefined): Promise<VectorHit[] | null> => {
    if (stopped !== null) return Promise.reject(new Error(stopped))
    const budget = Math.min(limitMs, giveUpMs ?? limitMs)
    // The caller has already given up: nothing to scan for.
    if (budget <= 0) return Promise.resolve(null)
    const deadlineAt = Date.now() + budget
    const id = nextId
    nextId += 1
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(id)?.resolve(null), budget)
      pending.set(id, { resolve, reject, timer })
      const post = (): void => {
        if (stopped !== null) {
          settle(id)?.reject(new Error(stopped))
          return
        }
        inWorker += 1
        worker.postMessage({ ...request, kind: 'request', id, deadlineAt } as WorkerRequest)
      }
      if (gated) held.push(post)
      else post()
    })
  }

  const exclusive: Exclusive = (fn) => {
    // Closed now, not in the queued run: a read asked right after this call must wait for fn too.
    gated = true
    exclusives += 1
    const run = async (): Promise<Awaited<ReturnType<typeof fn>>> => {
      try {
        if (inWorker > 0) await new Promise<void>((resolve) => idleWaiters.push(resolve))
        return fn() as Awaited<ReturnType<typeof fn>>
      } finally {
        exclusives -= 1
        if (exclusives === 0) {
          gated = false
          for (const post of held.splice(0)) post()
        }
      }
    }
    const result = gate.then(run, run)
    gate = result.catch(() => {})
    return result
  }

  return {
    ok: true,
    queries: {
      nearest: (query, giveUpMs) => ask({ op: 'nearest', query }, giveUpMs),
      distances: (query, giveUpMs) => ask({ op: 'distances', query }, giveUpMs),
      exclusive,
      close: () => {
        if (closing) return
        closing = true
        if (stopped !== null) {
          worker.terminate()
          return
        }
        stop('the search worker was closed')
        // The worker closes its connection first; terminate alone would leave the file handle open.
        const timer = setTimeout(() => closed?.(), CLOSE_WAIT_MS)
        closed = () => {
          clearTimeout(timer)
          closed = null
          worker.terminate()
        }
        worker.postMessage({ kind: 'close' })
      },
    },
  }
}
