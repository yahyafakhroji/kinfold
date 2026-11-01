// `bun src/daemon/replay-main.ts <copy of memory.db>`: replays the stored
// event timeline through the scheduler twice, with the pre-P1-E rules and
// with today's defaults, and prints runs per turn and both lag definitions as
// JSON (counts and ms only). Point it at a .backup copy, never the live
// database; it opens the file read-only either way.

import { openStoreFile } from '../sqlite/open'
import { type TimelineEvent, eventTimeline, runDurations } from '../store/replay-reads'
import { DEFAULT_SCHEDULE, LEGACY_SCHEDULE, type ObserverScheduleConfig } from './observer-scheduler'
import { runReplay } from './replay'
import { type ReplaySummary, summarizeReplay } from './replay-summary'

export interface ReplayReport {
  events: number
  hosts: string[]
  before: Record<string, ReplaySummary>
  after: Record<string, ReplaySummary>
}

async function replayWith(timeline: readonly TimelineEvent[], durations: Map<string, number[]>, hosts: readonly string[], config: ObserverScheduleConfig): Promise<Record<string, ReplaySummary>> {
  const runs = await runReplay(timeline, durations, { config })
  return Object.fromEntries([['all', summarizeReplay(timeline, runs)], ...hosts.map((host) => [host, summarizeReplay(timeline, runs, host)])])
}

export async function replayReport(path: string): Promise<ReplayReport> {
  const db = openStoreFile(path, { readonly: true })
  try {
    const timeline = eventTimeline(db)
    const durations = runDurations(db)
    const hosts = [...new Set(timeline.map((event) => event.host))].sort()
    return {
      events: timeline.length,
      hosts,
      before: await replayWith(timeline, durations, hosts, LEGACY_SCHEDULE),
      after: await replayWith(timeline, durations, hosts, DEFAULT_SCHEDULE),
    }
  } finally {
    db.close()
  }
}

if (import.meta.main) {
  const path = process.argv[2]
  if (path === undefined) {
    process.stderr.write('usage: bun src/daemon/replay-main.ts <copy of memory.db>\n')
    process.exit(2)
  }
  replayReport(path).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    (error: unknown) => {
      process.stderr.write(`replay failed: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    },
  )
}
