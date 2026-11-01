// Coalesces drain requests. Three tools nudging at once, plus the fallback
// interval, become one drain shortly after the first request.

export interface DrainScheduler {
  /** Schedules a drain unless one is already pending. Never blocks. */
  request(): void
  /** Resolves once no drain is pending. Lets callers wait without sleeping. */
  whenIdle(): Promise<void>
  stop(): void
}

export const DEFAULT_DEBOUNCE_MS = 25

export function createDrainScheduler(
  run: () => void,
  onError: (error: unknown) => void,
  debounceMs: number = DEFAULT_DEBOUNCE_MS,
): DrainScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null
  let waiters: (() => void)[] = []

  const settle = (): void => {
    const pending = waiters
    waiters = []
    for (const resolve of pending) resolve()
  }

  const fire = (): void => {
    timer = null
    try {
      run()
    } catch (error: unknown) {
      onError(error)
    }
    if (timer === null) settle()
  }

  return {
    request: () => {
      if (timer === null) timer = setTimeout(fire, debounceMs)
    },
    whenIdle: () => (timer === null ? Promise.resolve() : new Promise<void>((resolve) => waiters.push(resolve))),
    stop: () => {
      if (timer !== null) clearTimeout(timer)
      timer = null
      settle()
    },
  }
}
