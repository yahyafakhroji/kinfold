// A report the daemon keeps instead of computing on every page load: the last
// value and when it was computed. An ask within maxAgeMs gets it as it is; an
// older one gets it at once while a fresh one is computed behind it, so a
// page shows "as of N min ago" instead of waiting. Only the first ask, with
// nothing kept yet, waits. One computation runs at a time. After invalidate()
// (a purge, a retention change) the next ask waits for a value computed from
// then on: one already being computed read the store before the change, so it
// is let finish and is not handed out as the answer.

export interface KeptAnswer<T> {
  value: T
  asOf: number
  /** A newer value is being computed. */
  refreshing: boolean
}

export interface KeptReport<T> {
  get(): Promise<KeptAnswer<T>>
  /** The next ask computes again, waiting if nothing newer is kept: for after a change the report must show. */
  invalidate(): void
}

export interface KeptOptions {
  maxAgeMs: number
  now?: () => number
  /** Told when a background refresh fails; the kept value stays. */
  onError?: (error: unknown) => void
}

export function keptReport<T>(compute: () => Promise<T>, options: KeptOptions): KeptReport<T> {
  const now = options.now ?? Date.now
  type Kept = { value: T; asOf: number }
  /** Counts invalidations: a value is good for the generation its computation started in. */
  let generation = 0
  let kept: (Kept & { generation: number }) | null = null
  let running: { promise: Promise<Kept>; generation: number } | null = null

  const refresh = (): Promise<Kept> => {
    if (running !== null && running.generation === generation) return running.promise
    const startedIn = generation
    // Still one at a time: a computation from before the invalidation is waited out, whatever it ends in.
    const earlier = running?.promise.then(() => {}, () => {})
    // Declared before the computation starts: its first part runs in this same turn, and may end there too.
    const entry: { promise: Promise<Kept>; generation: number } = { promise: Promise.resolve({ value: undefined as T, asOf: 0 }), generation: startedIn }
    const run = async (): Promise<Kept> => {
      // Awaited only when there is one, so a first computation starts in the same turn as the ask.
      if (earlier !== undefined) await earlier
      const startedAt = now()
      try {
        const value = await compute()
        kept = { value, asOf: startedAt, generation: startedIn }
        return { value, asOf: startedAt }
      } finally {
        if (running === entry) running = null
      }
    }
    running = entry
    entry.promise = run()
    return entry.promise
  }

  return {
    get: async () => {
      if (kept === null || kept.generation !== generation) {
        const result = await refresh()
        return { ...result, refreshing: false }
      }
      const { value, asOf } = kept
      if (now() - asOf <= options.maxAgeMs) return { value, asOf, refreshing: running !== null }
      refresh().catch((error: unknown) => options.onError?.(error))
      return { value, asOf, refreshing: true }
    },
    invalidate: () => {
      generation += 1
    },
  }
}
