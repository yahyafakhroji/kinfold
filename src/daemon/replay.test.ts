import { expect, test } from 'bun:test'
import type { TimelineEvent } from '../store/replay-reads'
import { DEFAULT_SCHEDULE, LEGACY_SCHEDULE } from './observer-scheduler'
import { type ReplayRun, runReplay } from './replay'
import { summarizeReplay } from './replay-summary'

const T = 1_792_845_000_000
const RUN_MS = 10_000
const DURATIONS = new Map([['claude-code', [RUN_MS]]])

let sequence = 0
function ev(sessionId: number, kind: string, at: number, promptNumber: number | null = 1): TimelineEvent {
  sequence += 1
  return { eventId: `e${String(sequence).padStart(5, '0')}`, sessionId, host: 'claude-code', kind, promptNumber, occurredAt: at, ingestedAt: at + 50 }
}

/** One 10-minute turn: a prompt, a tool result every 40 s (never 60 s quiet, 15 results), then turn_end. */
function longTurn(sessionId: number, start: number, prompt: number): TimelineEvent[] {
  const results = Array.from({ length: 15 }, (_, i) => ev(sessionId, 'tool_result', start + (i + 1) * 40_000, prompt))
  return [ev(sessionId, 'user_prompt', start, prompt), ...results, ev(sessionId, 'turn_end', start + 640_000, prompt)]
}

test('a long turn: the waited rule cuts lag from event, and its extra runs stay within the per-turn cap', async () => {
  const timeline = [ev(1, 'session_start', T, null), ...longTurn(1, T + 1_000, 1), ...longTurn(1, T + 700_000, 2)]
  const before = summarizeReplay(timeline, await runReplay(timeline, DURATIONS, { config: LEGACY_SCHEDULE }))
  const after = summarizeReplay(timeline, await runReplay(timeline, DURATIONS, { config: DEFAULT_SCHEDULE }))

  expect(before.turns).toBe(2)
  expect(before.lagFromEventMs.samples).toBe(34)
  expect(after.lagFromEventMs.samples).toBe(34)
  expect(before.runsByReason.waited).toBeUndefined()
  expect(after.runsByReason.waited).toBeGreaterThan(0)
  expect(after.runsByReason.waited).toBeLessThanOrEqual(2 * DEFAULT_SCHEDULE.maxEarlyRunsPerTurn)
  expect(after.runs - before.runs).toBeLessThanOrEqual(2 * DEFAULT_SCHEDULE.maxEarlyRunsPerTurn)
  // Once the cap is spent the rest of the turn waits for 8 events as before, so only the middle moves.
  expect(after.lagFromEventMs.p50 as number).toBeLessThan(before.lagFromEventMs.p50 as number)
  expect(after.lagFromEventMs.p95 as number).toBeLessThanOrEqual(before.lagFromEventMs.p95 as number)
  expect(after.lagFromTurnEndMs.samples).toBe(2)
  expect(after.lagFromTurnEndMs.p95 as number).toBeLessThanOrEqual(2 * RUN_MS + 5_050)
})

test('a session that keeps working after its end: legacy ran one call per event, now it batches', async () => {
  const start = [ev(2, 'session_start', T, null), ev(2, 'user_prompt', T + 1_000), ev(2, 'session_end', T + 2_000, null)]
  const after = Array.from({ length: 12 }, (_, i) => ev(2, 'tool_result', T + 30_000 + i * 15_000, 2))
  const timeline = [...start, ...after, ev(2, 'turn_end', T + 30_000 + 12 * 15_000, 2)]
  const legacy = summarizeReplay(timeline, await runReplay(timeline, DURATIONS, { config: LEGACY_SCHEDULE }))
  const now = summarizeReplay(timeline, await runReplay(timeline, DURATIONS, { config: DEFAULT_SCHEDULE }))
  expect(legacy.runsByReason.ended).toBeGreaterThanOrEqual(10)
  expect(now.runsByReason.ended ?? 0).toBeLessThanOrEqual(1)
  expect(now.runs).toBeLessThanOrEqual(5)
  expect(now.lagFromEventMs.samples).toBe(legacy.lagFromEventMs.samples)
})

test('summary math: both lag definitions, turns, runs per turn and the busiest turn', () => {
  const timeline = [ev(3, 'user_prompt', 0, 1), ev(3, 'tool_result', 1_000, 1), ev(3, 'turn_end', 2_000, 1), ev(3, 'user_prompt', 5_000, 2), ev(3, 'session_end', 6_000, null)]
  const [p1, r1, t1, p2] = timeline.map((event) => event.eventId)
  const runs: ReplayRun[] = [
    { sessionId: 3, host: 'claude-code', reason: 'waited', startedAt: 1_500, finishedAt: 4_000, eventIds: [p1!, r1!] },
    { sessionId: 3, host: 'claude-code', reason: 'boundary', startedAt: 4_000, finishedAt: 9_000, eventIds: [t1!] },
    { sessionId: 3, host: 'claude-code', reason: 'quiet', startedAt: 9_000, finishedAt: 12_000, eventIds: [p2!] },
  ]
  expect(summarizeReplay(timeline, runs)).toEqual({
    runs: 3,
    turns: 2,
    runsPerTurn: 1.5,
    maxRunsPerTurn: 2,
    runsByReason: { waited: 1, boundary: 1, quiet: 1 },
    lagFromEventMs: { samples: 4, p50: 4_000, p95: 7_000 },
    lagFromTurnEndMs: { samples: 1, p50: 7_000, p95: 7_000 },
  })
  expect(summarizeReplay(timeline, runs, 'opencode')).toMatchObject({ runs: 0, turns: 0, runsPerTurn: null, maxRunsPerTurn: 0 })
})
