// GET /data/size reads every page of the store (dbstat), which on a 708 MB
// encrypted hub took 14 s: past the HTTP server's idle timeout, so the CLI
// saw its connection dropped. The report is kept instead. A fresh one is
// answered as it is; a stale one is answered at once while the next is
// worked out in the reports worker; with none yet, the caller waits a short
// while and is then told it is being worked out. One read at a time.

/** How long a report is answered without starting another. */
export const SIZE_FRESH_MS = 10 * 60_000
/** How long a caller with no report to fall back on waits for the first. */
export const SIZE_WAIT_MS = 5_000

export class SizeStillComputingError extends Error {
  constructor() {
    super('the size report is still being worked out on this store; try again in a minute')
    this.name = 'SizeStillComputingError'
  }
}

export interface Measured<T> {
  report: T
  measuredAt: number
}

export interface SizeCacheOptions {
  now?: () => number
  waitMs?: number
  freshMs?: number
}

export interface SizeCache<T> {
  get(): Promise<Measured<T>>
  /** Starts a read unless a fresh report is kept or one is running; for the core's start, so the first ask finds one. */
  refresh(): void
  /** The store changed (a purge, retention): the kept report is answered once more while a new one is read. */
  stale(): void
}

export function createSizeCache<T>(read: () => Promise<T>, options: SizeCacheOptions = {}): SizeCache<T> {
  const now = options.now ?? Date.now
  const waitMs = options.waitMs ?? SIZE_WAIT_MS
  const freshMs = options.freshMs ?? SIZE_FRESH_MS
  let kept: Measured<T> | null = null
  let running: Promise<Measured<T>> | null = null
  let changed = false
  const fresh = (): boolean => kept !== null && !changed && now() - kept.measuredAt < freshMs

  const start = (): Promise<Measured<T>> => {
    if (running !== null) return running
    const measuredAt = now()
    changed = false
    const reading = read().then((report) => (kept = { report, measuredAt }))
    running = reading
    // Cleared either way, so a failure is tried again on the next ask.
    reading.then(() => (running = null), () => (running = null))
    return reading
  }

  return {
    get: async () => {
      if (kept !== null && fresh()) return kept
      if (kept !== null) {
        // A failed refresh keeps the report there was; the next stale ask tries again.
        start().catch(() => {})
        return kept
      }
      const reading = start()
      let timer: ReturnType<typeof setTimeout> | undefined
      const waited = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), waitMs)
      })
      try {
        const first = await Promise.race([reading, waited])
        if (first === null) throw new SizeStillComputingError()
        return first
      } finally {
        clearTimeout(timer)
      }
    },
    refresh: () => {
      if (fresh()) return
      start().catch(() => {})
    },
    stale: () => {
      changed = true
    },
  }
}
