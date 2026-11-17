// Names what holds the daemon's thread. A hub once stopped answering /health
// for 80 s after an embedding switch with nothing in its log, and the cause
// could not be found afterwards. The synchronous steps the daemon runs (a
// core's start, a drain, vectors upkeep, the indexer's turn) go through
// step(), which logs one that held the thread past the threshold; a timer
// that comes back late logs the gap, with the named steps that ran inside
// it, so a block outside every step still shows when and how long. Names and
// times only.

/** Past this, a hook's whole wait is gone and /health callers start giving up. */
export const STALL_THRESHOLD_MS = 1_000
export const STALL_TICK_MS = 250
/** Steps kept to name a gap: a gap far longer than this many steps still names the latest. */
const KEPT_STEPS = 32

export interface StallWatch {
  /** Runs fn now, timed under `label`. */
  step<T>(label: string, fn: () => T): T
  stop(): void
}

export interface StallWatchOptions {
  log: (line: string) => void
  thresholdMs?: number
  intervalMs?: number
}

interface DoneStep {
  label: string
  startedAt: number
  ms: number
}

export function createStallWatch(options: StallWatchOptions): StallWatch {
  const thresholdMs = options.thresholdMs ?? STALL_THRESHOLD_MS
  const intervalMs = options.intervalMs ?? STALL_TICK_MS
  const done: DoneStep[] = []
  let lastTick = performance.now()

  const timer = setInterval(() => {
    const at = performance.now()
    const gap = at - lastTick - intervalMs
    if (gap > thresholdMs) {
      const inside = done.filter((entry) => entry.startedAt >= lastTick).map((entry) => `${entry.label} ms=${Math.round(entry.ms)}`)
      options.log(`main thread blocked ms=${Math.round(gap)}; named steps in it: ${inside.length === 0 ? 'none' : inside.join(', ')}`)
    }
    lastTick = at
  }, intervalMs)
  // A watch never keeps a process alive on its own.
  timer.unref?.()

  return {
    step: (label, fn) => {
      const startedAt = performance.now()
      try {
        return fn()
      } finally {
        const ms = performance.now() - startedAt
        done.push({ label, startedAt, ms })
        if (done.length > KEPT_STEPS) done.shift()
        if (ms > thresholdMs) options.log(`main thread held ms=${Math.round(ms)} by ${label}`)
      }
    },
    stop: () => clearInterval(timer),
  }
}
