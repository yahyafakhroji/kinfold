// The daemon's side of a store reader worker (store-reader-worker.ts): reads
// of memory.db on a thread of their own, so the thread that answers hooks,
// /health and captures never waits on them. On a 30,000-memory hub the
// prompt path's SQL and the dashboard's size, metrics and facets reads held
// that thread for seconds at a time. One worker answers one read at a time,
// in order; the daemon runs one for recall and one for the dashboard, so a
// long report never queues ahead of a prompt. Until a worker is up, and after
// one stops, reads run on the daemon's own connection, as they always did.

import { isCompiledProgram } from '../runtime/program'
import type { Database } from '../sqlite/types'
import type { StoreReaderReply, StoreReaderRequest, StoreReaderStart } from './store-reader-protocol'
import { type StoreReadArgs, type StoreReadName, type StoreReadResult, runStoreRead } from './store-reads'

/** How long one read may take before its caller is told it failed. Cold reads of a large encrypted store take seconds. */
export const READ_LIMIT_MS = 60_000
/** How long a worker may take to open the store; reads run on the daemon connection meanwhile, and a stop waits at most this long for it. */
export const START_LIMIT_MS = 15_000
/** How long a hold waits for a starting worker before holding what is running now. */
export const HOLD_START_WAIT_MS = 2_000
/** How long close waits for the worker to close its connection before ending it anyway. */
export const CLOSE_WAIT_MS = 2_000

/** The worker inside a compiled program, by its path from the entries' common folder (tools/build-release.test.ts holds them in step). */
export const COMPILED_STORE_READER_PATH = './workers/store-reader-worker.ts'

export interface RunOptions {
  /** The worker skips the read if it has not started it by then: its caller stopped waiting. */
  expireMs?: number
}

export interface StoreReader {
  run<K extends StoreReadName>(op: K, args: StoreReadArgs<K>, options?: RunOptions): Promise<StoreReadResult<K>>
  /**
   * Waits until no read is in the worker, and keeps new ones back until the
   * returned release is called: a TRUNCATE checkpoint (purge, retention,
   * resolve) waits for every reader to leave the WAL.
   */
  hold(): Promise<() => void>
  /** Settles once the worker has closed its connection and ended; the same promise on every call. */
  close(): Promise<void>
  /** Settles once a worker asked to start has started or given up; at once when none was asked. */
  started?(): Promise<void>
}

/** Thrown to a caller whose read waited past its expiry and was skipped. */
export class ReadExpiredError extends Error {
  constructor() {
    super('the read expired before the worker reached it')
    this.name = 'ReadExpiredError'
  }
}

const STOPPED_PREFIX = 'the store reader stopped'

const released = (): void => {}

/** The same reads on a connection the caller owns, on the caller's thread. */
export function inlineStoreReader(db: Database, dbPath: string): StoreReader {
  return {
    run: async (op, args) => runStoreRead(db, dbPath, op, args) as StoreReadResult<typeof op>,
    hold: async () => released,
    close: async () => {},
  }
}

export type StoreReaderStartResult = { ok: true; reader: StoreReader } | { ok: false; reason: string }

export interface StoreReaderOptions extends Omit<StoreReaderStart, 'kind'> {
  limitMs?: number
  startLimitMs?: number
  /** The worker script; tests pass their own. */
  workerUrl?: string
}

function workerUrl(): string {
  return isCompiledProgram() ? COMPILED_STORE_READER_PATH : new URL('./store-reader-worker.ts', import.meta.url).href
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: Timer
}

/** Gates new requests and counts the ones in the worker, for hold(). */
function createGate() {
  let inWorker = 0
  let idle: (() => void)[] = []
  let held: (() => void)[] = []
  let holds = 0
  return {
    get holding(): boolean {
      return holds > 0
    },
    entered: () => void (inWorker += 1),
    left: () => {
      inWorker = Math.max(0, inWorker - 1)
      if (inWorker === 0) for (const wake of idle.splice(0)) wake()
    },
    clear: () => {
      inWorker = 0
      for (const wake of idle.splice(0)) wake()
      for (const post of held.splice(0)) post()
    },
    later: (post: () => void) => void held.push(post),
    hold: async (): Promise<() => void> => {
      holds += 1
      if (inWorker > 0) await new Promise<void>((resolve) => idle.push(resolve))
      let done = false
      return () => {
        if (done) return
        done = true
        holds -= 1
        if (holds === 0) for (const post of held.splice(0)) post()
      }
    },
  }
}

export async function startStoreReader(options: StoreReaderOptions): Promise<StoreReaderStartResult> {
  const limitMs = options.limitMs ?? READ_LIMIT_MS
  const worker = new Worker(options.workerUrl ?? workerUrl())
  const pending = new Map<number, Pending>()
  const gate = createGate()
  let nextId = 1
  let stopped: string | null = null
  let started: ((reply: StoreReaderReply) => void) | null = null
  let closed: (() => void) | null = null
  let closing = false
  let closeDone: Promise<void> | null = null

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
    for (const id of [...pending.keys()]) settle(id)?.reject(new Error(stopped))
    gate.clear()
  }
  worker.onmessage = (event: MessageEvent<StoreReaderReply>) => {
    const reply = event.data
    if (reply.kind === 'started') return void started?.(reply)
    if (reply.kind === 'closed') return void closed?.()
    gate.left()
    const entry = settle(reply.id)
    if (reply.kind === 'answer') entry?.resolve(reply.value)
    else if (reply.kind === 'expired') entry?.reject(new ReadExpiredError())
    else entry?.reject(new Error(reply.reason))
  }
  const ended = (why: string): void => {
    stop(`${STOPPED_PREFIX} (${why})`)
    started?.({ kind: 'started', ok: false, reason: 'the store reader stopped while starting' })
    closed?.()
  }
  worker.onerror = (event: ErrorEvent) => ended(event.message.slice(0, 120))
  // An exit with no error event would otherwise leave reads counted in the worker and hold() waiting forever.
  worker.addEventListener('close', () => {
    if (!closing) ended('it exited')
  })

  const reply = await new Promise<StoreReaderReply>((resolve) => {
    const startLimit = Math.min(limitMs, options.startLimitMs ?? START_LIMIT_MS)
    const timer = setTimeout(() => resolve({ kind: 'started', ok: false, reason: `the store reader did not start within ${startLimit} ms` }), startLimit)
    started = (message) => {
      clearTimeout(timer)
      started = null
      resolve(message)
    }
    const start: StoreReaderStart = { kind: 'start', dbPath: options.dbPath, dataDir: options.dataDir, key: options.key, libraryOverride: options.libraryOverride, cacheKib: options.cacheKib }
    worker.postMessage(start)
  })
  if (reply.kind !== 'started' || !reply.ok) {
    worker.terminate()
    return { ok: false, reason: reply.kind === 'started' && !reply.ok ? reply.reason : 'the store reader did not start' }
  }

  const run = <K extends StoreReadName>(op: K, args: StoreReadArgs<K>, runOptions: RunOptions = {}): Promise<StoreReadResult<K>> => {
    if (stopped !== null) return Promise.reject(new Error(stopped))
    const id = nextId
    nextId += 1
    const expireAt = Date.now() + Math.min(limitMs, runOptions.expireMs ?? limitMs)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle(id)?.reject(new Error(`the read ran past ${limitMs} ms`)), limitMs)
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      const post = (): void => {
        if (stopped !== null) return void settle(id)?.reject(new Error(stopped))
        gate.entered()
        worker.postMessage({ kind: 'request', id, expireAt, op, args } satisfies StoreReaderRequest)
      }
      if (gate.holding) gate.later(post)
      else post()
    })
  }

  return {
    ok: true,
    reader: {
      run,
      hold: () => gate.hold(),
      close: () => {
        if (closeDone !== null) return closeDone
        closing = true
        closeDone = new Promise<void>((resolve) => {
          if (stopped !== null) {
            worker.terminate()
            return resolve()
          }
          stop('the store reader was closed')
          // The worker closes its connection first: terminate alone leaves the file open, and Windows cannot delete it.
          const timer = setTimeout(() => closed?.(), CLOSE_WAIT_MS)
          closed = () => {
            clearTimeout(timer)
            closed = null
            worker.terminate()
            resolve()
          }
          worker.postMessage({ kind: 'close' })
        })
        return closeDone
      },
    },
  }
}

/**
 * The worker once it has started, `inline` until then and after it stops.
 * The worker is started by the first read, or at once when the caller asks
 * (the prompt path's readers, whose first read must not pay for opening an
 * encrypted store). Unlike the vector search, a read never waits for the
 * worker to start: a prompt asked in the first moments after a restart is
 * answered from the daemon's own connection, unless the caller asks it to
 * wait (ReaderOrInlineOptions).
 */
export interface ReaderOrInlineOptions {
  /**
   * Reads wait for the worker to start instead of running on the daemon
   * connection meanwhile: for the dashboard's reports, where one read can hold
   * the daemon's thread for seconds and a short wait costs nothing.
   */
  waitForStart?: boolean
  /** Starts the worker now instead of on the first read. */
  eager?: boolean
  /** Run once on the worker as soon as it is up, so its first real read finds the connection set up. */
  warm?: (reader: StoreReader) => Promise<unknown>
}

export function readerOrInline(name: string, start: () => Promise<StoreReaderStartResult>, inline: StoreReader, log: (line: string) => void, options: ReaderOrInlineOptions = {}): StoreReader {
  let current: StoreReader = inline
  let worker: StoreReader | null = null
  let ready: Promise<void> | null = null
  let closing: Promise<void> | null = null
  const begin = (): void => {
    if (ready !== null || closing !== null) return
    ready = start()
      .then((started) => {
        if (!started.ok) return log(`${name} reader worker off (${started.reason}); reading on the daemon connection`)
        worker = started.reader
        // Closed while it started: it is closed below and never used.
        if (closing === null) current = started.reader
        if (closing === null && options.warm !== undefined) {
          return options.warm(started.reader).then(() => {}, (error: unknown) => log(`${name} reader warm-up failed: ${error instanceof Error ? error.name : 'error'}`))
        }
      })
      .catch((error: unknown) => log(`${name} reader worker off (${error instanceof Error ? error.message : 'it failed to start'}); reading on the daemon connection`))
  }
  const fallBack = (error: unknown): StoreReader => {
    if (!(error instanceof Error) || !error.message.startsWith(STOPPED_PREFIX)) throw error
    // Every read in flight when the worker stopped falls back; only the first one logs and closes it.
    if (current !== inline) {
      log(`${name} reader worker stopped (${error.message.slice(STOPPED_PREFIX.length).replace(/^ \(|\)$/g, '')}); reading on the daemon connection`)
      void current.close()
      current = inline
    }
    return inline
  }
  if (options.eager === true) begin()
  return {
    run: async (op, args, runOptions) => {
      begin()
      if (options.waitForStart === true && ready !== null) await ready
      const reader = current
      try {
        return await reader.run(op, args, runOptions)
      } catch (error: unknown) {
        return fallBack(error).run(op, args, runOptions)
      }
    },
    started: async () => {
      await ready
    },
    // A hold asked while the worker starts waits for it (briefly), so the reads it holds back include the worker's.
    hold: async () => {
      if (ready !== null) await Promise.race([ready, Bun.sleep(HOLD_START_WAIT_MS)])
      return current.hold()
    },
    close: () => {
      closing ??= (ready ?? Promise.resolve()).then(() => (worker as StoreReader | null)?.close())
      current = inline
      return closing
    },
  }
}
