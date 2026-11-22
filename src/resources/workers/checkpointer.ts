// The daemon's side of the checkpoint worker (checkpoint-worker.ts). A timer
// asks for a PASSIVE checkpoint, which copies what it can without waiting on
// the daemon's writer or any reader. Once every frame is in the store and the
// WAL file has grown past a limit, it asks for a TRUNCATE, which then only
// resets the file. Work that needs no checkpoint running beside it (a purge's
// own TRUNCATE, a backup snapshot) holds it, and a store core closes it
// before the store does.

import { existsSync, statSync } from 'node:fs'
import { isCompiledProgram } from '../runtime/program'
import type { CheckpointMode, CheckpointReply, CheckpointResult, CheckpointStart } from './checkpoint-protocol'

/** How often the WAL is copied into the store. */
export const CHECKPOINT_INTERVAL_MS = 1_000
/** A WAL file past this, with every frame copied, is truncated. */
export const WAL_TRUNCATE_BYTES = 64 * 1024 * 1024
/** How long the worker may take to open the store. */
export const CHECKPOINT_START_LIMIT_MS = 15_000
/** How long one checkpoint may take before its caller stops waiting; the worker goes on. */
export const CHECKPOINT_LIMIT_MS = 60_000
/** A checkpoint past this is logged, so a held thread can be set beside it. */
export const CHECKPOINT_SLOW_MS = 1_000
/**
 * How long close waits for the worker to close its connection before ending
 * it anyway. The worker answers after the checkpoint in flight, which took up
 * to 4.5 s on the Windows runner; one ended before that keeps its file open,
 * and Windows cannot delete it.
 */
export const CHECKPOINT_CLOSE_WAIT_MS = 10_000

/** The worker inside a compiled program, by its path from the entries' common folder (tools/build-release.test.ts holds them in step). */
export const COMPILED_CHECKPOINT_WORKER_PATH = './workers/checkpoint-worker.ts'

export interface Checkpointer {
  /** Waits for the checkpoint in flight and keeps the next back until the returned release is called. */
  hold(): Promise<() => void>
  /** One checkpoint now, after any hold; null once closed. */
  checkpointNow(): Promise<CheckpointResult | null>
  /** The last checkpoint's result; null before the first. */
  lastResult(): CheckpointResult | null
  /**
   * Whether a checkpoint is in flight. On Windows a write on another
   * connection waits for it, its sync of the store above all, which took
   * seconds on the CI runner.
   */
  busy(): boolean
  /** Settles once the worker has closed its connection and ended; the same promise on every call. */
  close(): Promise<void>
}

export interface CheckpointerOptions extends Omit<CheckpointStart, 'kind'> {
  intervalMs?: number
  truncateBytes?: number
  startLimitMs?: number
  log: (line: string) => void
  /** Called once if the worker stops on its own: the daemon's connection then checkpoints itself again. */
  onStopped?: () => void
  /** The worker script; tests pass their own. */
  workerUrl?: string
}

export type CheckpointerStart = { ok: true; checkpointer: Checkpointer } | { ok: false; reason: string }

function workerUrl(): string {
  return isCompiledProgram() ? COMPILED_CHECKPOINT_WORKER_PATH : new URL('./checkpoint-worker.ts', import.meta.url).href
}

function walBytes(dbPath: string): number {
  const path = `${dbPath}-wal`
  try {
    return existsSync(path) ? statSync(path).size : 0
  } catch {
    return 0
  }
}

export async function startCheckpointer(options: CheckpointerOptions): Promise<CheckpointerStart> {
  const truncateBytes = options.truncateBytes ?? WAL_TRUNCATE_BYTES
  const worker = new Worker(options.workerUrl ?? workerUrl())
  const pending = new Map<number, (reply: CheckpointReply | null) => void>()
  let nextId = 1
  let stopped = false
  let closing = false
  let running = false
  let closeDone: Promise<void> | null = null
  let started: ((reply: CheckpointReply) => void) | null = null
  let closed: (() => void) | null = null
  let last: CheckpointResult | null = null
  // One checkpoint at a time, and none while held.
  let chain: Promise<unknown> = Promise.resolve()
  let holds = 0
  const heldWaiters: (() => void)[] = []

  const stop = (): void => {
    if (stopped) return
    stopped = true
    for (const [id, settle] of [...pending]) {
      pending.delete(id)
      settle(null)
    }
    for (const wake of heldWaiters.splice(0)) wake()
  }
  const ended = (why: string): void => {
    const wasRunning = running && !stopped && !closing
    stop()
    started?.({ kind: 'started', ok: false, reason: `the checkpoint worker stopped while starting (${why})` })
    closed?.()
    if (wasRunning) {
      options.log(`checkpoint worker stopped (${why}); the daemon connection checkpoints again`)
      options.onStopped?.()
    }
  }
  worker.onmessage = (event: MessageEvent<CheckpointReply>) => {
    const reply = event.data
    if (reply.kind === 'started') return void started?.(reply)
    if (reply.kind === 'closed') return void closed?.()
    const settle = pending.get(reply.id)
    pending.delete(reply.id)
    settle?.(reply)
  }
  worker.onerror = (event: ErrorEvent) => ended(event.message.slice(0, 120))
  worker.addEventListener('close', () => {
    if (!closing) ended('it exited')
  })

  const reply = await new Promise<CheckpointReply>((resolve) => {
    const limit = options.startLimitMs ?? CHECKPOINT_START_LIMIT_MS
    const timer = setTimeout(() => resolve({ kind: 'started', ok: false, reason: `the checkpoint worker did not start within ${limit} ms` }), limit)
    started = (message) => {
      clearTimeout(timer)
      started = null
      resolve(message)
    }
    worker.postMessage({ kind: 'start', dbPath: options.dbPath, key: options.key, libraryOverride: options.libraryOverride } satisfies CheckpointStart)
  })
  if (reply.kind !== 'started' || !reply.ok) {
    closing = true
    worker.terminate()
    return { ok: false, reason: reply.kind === 'started' && !reply.ok ? reply.reason : 'the checkpoint worker did not start' }
  }
  running = true

  const ask = (mode: CheckpointMode): Promise<CheckpointResult | null> => {
    if (stopped) return Promise.resolve(null)
    const id = nextId
    nextId += 1
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(null)
      }, CHECKPOINT_LIMIT_MS)
      pending.set(id, (answer) => {
        clearTimeout(timer)
        if (answer === null || answer.kind !== 'done') {
          if (answer?.kind === 'failed') options.log(`checkpoint failed (${answer.reason})`)
          return resolve(null)
        }
        last = answer.result
        resolve(answer.result)
      })
      worker.postMessage({ kind: 'checkpoint', id, mode })
    })
  }

  const timedAsk = async (mode: CheckpointMode): Promise<CheckpointResult | null> => {
    const startedAt = performance.now()
    const result = await ask(mode)
    const ms = performance.now() - startedAt
    if (ms >= CHECKPOINT_SLOW_MS) options.log(`checkpoint slow mode=${mode} ms=${Math.round(ms)} log=${result?.log ?? -1} checkpointed=${result?.checkpointed ?? -1} busy=${result?.busy ?? -1} wal_bytes=${walBytes(options.dbPath)}`)
    return result
  }

  const turn = async (): Promise<CheckpointResult | null> => {
    if (stopped) return null
    const result = await timedAsk('PASSIVE')
    // Every frame copied: a TRUNCATE now only resets the file, and without waiting for anyone.
    if (result !== null && result.busy === 0 && result.checkpointed === result.log && walBytes(options.dbPath) > truncateBytes) return (await timedAsk('TRUNCATE')) ?? result
    return result
  }

  /** Runs after the checkpoint in flight, and after every hold is released. */
  const queued = (): Promise<CheckpointResult | null> => {
    const next = chain.then(async () => {
      while (holds > 0 && !stopped) await new Promise<void>((resolve) => heldWaiters.push(resolve))
      return turn()
    })
    chain = next.catch(() => null)
    return next
  }

  let ticking = false
  const timer = setInterval(() => {
    if (ticking || holds > 0 || stopped) return
    ticking = true
    void queued().finally(() => {
      ticking = false
    })
  }, options.intervalMs ?? CHECKPOINT_INTERVAL_MS)
  timer.unref?.()

  const checkpointer: Checkpointer = {
    hold: async () => {
      holds += 1
      // The checkpoint in flight finishes first.
      await chain
      let released = false
      return () => {
        if (released) return
        released = true
        holds -= 1
        if (holds === 0) for (const wake of heldWaiters.splice(0)) wake()
      }
    },
    checkpointNow: () => (stopped ? Promise.resolve(null) : queued()),
    lastResult: () => last,
    busy: () => pending.size > 0,
    close: () => {
      if (closeDone !== null) return closeDone
      closing = true
      clearInterval(timer)
      closeDone = new Promise<void>((resolve) => {
        if (stopped) {
          worker.terminate()
          return resolve()
        }
        stop()
        // The worker closes its connection first: terminate alone leaves the file open, and Windows cannot delete it.
        const wait = setTimeout(() => closed?.(), CHECKPOINT_CLOSE_WAIT_MS)
        closed = () => {
          clearTimeout(wait)
          closed = null
          worker.terminate()
          resolve()
        }
        worker.postMessage({ kind: 'close' })
      })
      return closeDone
    },
  }
  return { ok: true, checkpointer }
}
