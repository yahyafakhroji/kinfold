// How the daemon runs vectors upkeep without holding its thread. Each slice is
// bounded (space-manager.ts: one index window, one sweep chunk); between
// slices the turn yields to the event loop, so a /health, a hook or a central
// device's request waiting behind it is answered before the next slice. A turn
// stops at its budget and the next tick goes on from there.

/** Work a turn may do before it waits for the next tick. */
export const UPKEEP_TURN_BUDGET_MS = 250

export interface UpkeepTurnOptions {
  /** One bounded slice; true when there is more to do soon. */
  slice: () => boolean
  budgetMs?: number
  now?: () => number
  onError?: (error: unknown) => void
}

export interface UpkeepTurns {
  /** Runs a turn, or joins the one already running. */
  run(): Promise<void>
  /** Before the store closes: the running turn ends after its slice, and no slice runs again. */
  stop(): Promise<void>
}

const nextTask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function createUpkeepTurns(options: UpkeepTurnOptions): UpkeepTurns {
  const budgetMs = options.budgetMs ?? UPKEEP_TURN_BUDGET_MS
  const now = options.now ?? (() => performance.now())
  let running: Promise<void> | null = null
  let stopped = false

  const turn = async (): Promise<void> => {
    const startedAt = now()
    while (!stopped) {
      let more: boolean
      try {
        more = options.slice()
      } catch (error: unknown) {
        options.onError?.(error)
        return
      }
      if (!more || now() - startedAt >= budgetMs) return
      await nextTask()
    }
  }

  return {
    run: () => {
      if (stopped) return Promise.resolve()
      running ??= turn().finally(() => {
        running = null
      })
      return running
    },
    stop: async () => {
      stopped = true
      await running
    },
  }
}
