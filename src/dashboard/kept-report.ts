// A report the daemon keeps instead of computing on every page load: the last
// value and when it was computed. An ask within maxAgeMs gets it as it is; an
// older one gets it at once while a fresh one is computed behind it, so a
// page shows "as of N min ago" instead of waiting. Only the first ask, with
// nothing kept yet, waits. One computation runs at a time.

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
  let kept: { value: T; asOf: number } | null = null
  let running: Promise<{ value: T; asOf: number }> | null = null
  let fresh = true

  const refresh = (): Promise<{ value: T; asOf: number }> => {
    running ??= (async () => {
      const startedAt = now()
      try {
        const value = await compute()
        kept = { value, asOf: startedAt }
        fresh = true
        return kept
      } finally {
        running = null
      }
    })()
    return running
  }

  return {
    get: async () => {
      if (kept === null || !fresh) {
        const result = await refresh()
        return { ...result, refreshing: false }
      }
      if (now() - kept.asOf <= options.maxAgeMs) return { ...kept, refreshing: running !== null }
      refresh().catch((error: unknown) => options.onError?.(error))
      return { ...kept, refreshing: true }
    },
    invalidate: () => {
      fresh = false
    },
  }
}
