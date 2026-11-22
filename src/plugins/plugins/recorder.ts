// How a plugin captures: it lives in the agent's own process for hours, where
// the hook CLI lives for one event. Each event is still redacted and written to
// the spool at once, so nothing is lost if the host exits, but the daemon is
// told once per burst and not once per event: a turn with twenty tool calls
// used to read daemon.json and the token twenty times and send twenty requests.

import { type NudgeResult, nudgeDaemon, spoolEvent } from '../../controllers/cli/record'
import type { NormalizedEvent } from '../../system/contract/event'

/** Events that arrive within this of each other share one nudge. Far below the daemon's own fallback interval. */
export const NUDGE_COALESCE_MS = 100

export interface PluginRecorderOptions {
  dataDir: string
  /** Called once per nudge that did not reach the daemon, with how many events it stood for. */
  onNudgeSkipped: (reason: string, events: number) => void
  coalesceMs?: number
  /** Test seams. */
  spool?: (event: NormalizedEvent, dataDir: string) => string
  nudge?: (dataDir: string) => Promise<NudgeResult>
}

export interface PluginRecorder {
  /** Spools the event now and schedules the shared nudge. Throws what the spool write throws. */
  record(event: NormalizedEvent): void
}

export function createPluginRecorder(options: PluginRecorderOptions): PluginRecorder {
  const spool = options.spool ?? spoolEvent
  const nudge = options.nudge ?? nudgeDaemon
  let waiting = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const send = (): void => {
    const events = waiting
    waiting = 0
    timer = null
    // nudgeDaemon never throws; the catch covers an injected one.
    nudge(options.dataDir).then(
      (result) => {
        if (!result.ok) options.onNudgeSkipped(result.reason, events)
      },
      () => options.onNudgeSkipped('nudge failed', events),
    )
  }

  return {
    record(event) {
      spool(event, options.dataDir)
      waiting += 1
      if (timer !== null) return
      timer = setTimeout(send, options.coalesceMs ?? NUDGE_COALESCE_MS)
      // The host must be free to exit; a nudge it never sent is covered by the daemon's own interval.
      timer.unref?.()
    },
  }
}
