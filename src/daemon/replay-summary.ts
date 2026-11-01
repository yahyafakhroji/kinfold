// Pure numbers over a replay (src/daemon/replay.ts). The two lag definitions:
//   lag from event    run finish - occurred_at, for every citable event
//                     (user_prompt, tool_result, turn_end): how long any one
//                     thing the agent did took to become searchable.
//   lag from turn end run finish - occurred_at of the turn_end, for the run
//                     that took the turn_end: how long after the agent stopped
//                     its whole turn was searchable (runs take events oldest
//                     first, so the rest of the turn was in that run or before).
// A turn is a (session, prompt_number) pair; a run belongs to the turn of its
// newest event that has a prompt number. Runs per turn is cost: every run is
// one paid observer call.

import { type Percentiles, percentiles } from '../dashboard/metrics'
import type { TimelineEvent } from '../store/replay-reads'
import type { ReplayRun } from './replay'

export interface ReplaySummary {
  runs: number
  turns: number
  runsPerTurn: number | null
  maxRunsPerTurn: number
  runsByReason: Record<string, number>
  lagFromEventMs: Percentiles
  lagFromTurnEndMs: Percentiles
}

const CITABLE: ReadonlySet<string> = new Set(['user_prompt', 'tool_result', 'turn_end'])

function turnKey(sessionId: number, promptNumber: number): string {
  return `${sessionId}:${promptNumber}`
}

function finishedAt(runs: readonly ReplayRun[]): Map<string, number> {
  return new Map(runs.flatMap((run) => run.eventIds.map((id) => [id, run.finishedAt] as const)))
}

function runTurn(run: ReplayRun, byId: ReadonlyMap<string, TimelineEvent>): string | null {
  const numbered = run.eventIds.map((id) => byId.get(id)).filter((event): event is TimelineEvent => event?.promptNumber != null)
  const newest = numbered.reduce<TimelineEvent | null>((best, event) => (best === null || event.occurredAt >= best.occurredAt ? event : best), null)
  return newest === null ? null : turnKey(newest.sessionId, newest.promptNumber as number)
}

function lags(events: readonly TimelineEvent[], done: ReadonlyMap<string, number>): number[] {
  return events.flatMap((event) => {
    const at = done.get(event.eventId)
    return at === undefined ? [] : [at - event.occurredAt]
  })
}

function tally(keys: readonly string[]): Record<string, number> {
  return keys.reduce<Record<string, number>>((counts, key) => ({ ...counts, [key]: (counts[key] ?? 0) + 1 }), {})
}

/** `host` limits everything to one host's sessions. */
export function summarizeReplay(timeline: readonly TimelineEvent[], allRuns: readonly ReplayRun[], host?: string): ReplaySummary {
  const events = host === undefined ? timeline : timeline.filter((event) => event.host === host)
  const runs = host === undefined ? allRuns : allRuns.filter((run) => run.host === host)
  const byId = new Map(events.map((event) => [event.eventId, event]))
  const done = finishedAt(runs)
  const turns = new Set(events.filter((event) => event.promptNumber !== null).map((event) => turnKey(event.sessionId, event.promptNumber as number)))
  const perTurn = tally(runs.map((run) => runTurn(run, byId)).filter((key): key is string => key !== null))
  return {
    runs: runs.length,
    turns: turns.size,
    runsPerTurn: turns.size === 0 ? null : runs.length / turns.size,
    maxRunsPerTurn: Math.max(0, ...Object.values(perTurn)),
    runsByReason: tally(runs.map((run) => run.reason)),
    lagFromEventMs: percentiles(lags(events.filter((event) => CITABLE.has(event.kind)), done)),
    lagFromTurnEndMs: percentiles(lags(events.filter((event) => event.kind === 'turn_end'), done)),
  }
}
