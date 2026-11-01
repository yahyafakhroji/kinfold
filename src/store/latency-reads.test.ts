import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type LatencySummary, metricsRoute, summarizeLatency } from '../dashboard/metrics'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { PROJECT, T0, type TempStore, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { eventStages, turnLags } from './latency-reads'
import { finishRun, insertObservation, startRun } from './observer-store'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-latency-')
})
afterEach(() => temp.cleanup())

const DAY = 24 * 3_600_000

function event(session: number, kind: 'tool_result' | 'turn_end', at: number, ingestDelay: number): string {
  const id = seedEvent(temp.store, session, { kind, at, tool: kind === 'tool_result' ? { name: 'Bash', output: 'x' } : undefined })
  temp.store.db.query('UPDATE events SET ingested_at = $at WHERE event_id = $id').run({ id, at: at + ingestDelay })
  return id
}

function run(session: number, host: string, provider: string, startedAt: number, finishedAt: number, status: 'succeeded' | 'failed' = 'succeeded'): void {
  const id = startRun(temp.store.db, { sessionId: session, host, provider, model: 'm', eventCount: 1, startedAt })
  finishRun(temp.store.db, id, status, status === 'failed' ? 'timeout: x' : null, finishedAt)
}

function observation(session: number, host: string, eventIds: string[], createdAt: number, tag: string): void {
  insertObservation(temp.store.db, {
    projectKey: PROJECT, sessionId: session, host, promptNumber: 1, type: 'discovery', title: tag, narrative: '', facts: '[]', files: '[]',
    evidence: 'tool-verified', sourceEventIds: JSON.stringify(eventIds), observerModel: 'm', contentHash: tag, occurredAt: createdAt, createdAt,
  })
}

/** claude-code: two events, a turn_end, a failed run, then a succeeded one. opencode: one event two days earlier. */
function seed(): void {
  const cc = seedSession(temp.store, 'claude-code', 'cc', T0)
  const e1 = event(cc, 'tool_result', T0, 100)
  const e2 = event(cc, 'tool_result', T0 + 1_000, 50)
  event(cc, 'turn_end', T0 + 2_000, 10)
  run(cc, 'claude-code', 'claude-cli', T0 + 3_000, T0 + 4_000, 'failed')
  run(cc, 'claude-code', 'claude-cli', T0 + 5_000, T0 + 15_000)
  observation(cc, 'claude-code', [e1, e2], T0 + 15_000, 'a')
  observation(cc, 'claude-code', [e2], T0 + 15_000, 'b')

  const oc = seedSession(temp.store, 'opencode', 'oc', T0 - 2 * DAY)
  const e3 = event(oc, 'tool_result', T0 - 2 * DAY, 20)
  run(oc, 'opencode', 'openrouter', T0 - 2 * DAY + 1_000, T0 - 2 * DAY + 4_000)
  observation(oc, 'opencode', [e3], T0 - 2 * DAY + 4_000, 'c')
}

const latencyOf = (answer: { body: unknown }): LatencySummary => (answer.body as { latency: LatencySummary }).latency

test('each cited event splits into ingest, scheduler, run and write, joined to its succeeded run, once per event', () => {
  seed()
  const rows = eventStages(temp.store.db, T0 - DAY).sort((a, b) => a.lagMs - b.lagMs)
  expect(rows).toEqual([
    { host: 'claude-code', provider: 'claude-cli', ingestMs: 50, schedulerMs: 3_950, runMs: 10_000, writeMs: 0, lagMs: 14_000 },
    { host: 'claude-code', provider: 'claude-cli', ingestMs: 100, schedulerMs: 4_900, runMs: 10_000, writeMs: 0, lagMs: 15_000 },
  ])
  expect(eventStages(temp.store.db, T0 - 3 * DAY)).toHaveLength(3)
})

test('lag from turn end runs to the first succeeded run that started after the turn_end was ingested', () => {
  seed()
  expect(turnLags(temp.store.db, T0 - DAY)).toEqual([{ host: 'claude-code', provider: 'claude-cli', lagMs: 13_000 }])
})

test('the summary groups by host and provider and honours the 24h and 7d windows', () => {
  seed()
  const day = metricsRoute(temp.store.db, '24h', () => T0 + 20_000)
  expect(day.status).toBe(200)
  const latency = latencyOf(day)
  expect(latency.window).toBe('24h')
  expect(latency.all.schedulerMs).toEqual({ samples: 2, p50: 3_950, p95: 4_900 })
  expect(latency.all.lagFromEventMs).toEqual({ samples: 2, p50: 14_000, p95: 15_000 })
  expect(latency.all.lagFromTurnEndMs).toEqual({ samples: 1, p50: 13_000, p95: 13_000 })
  expect(latency.groups.map((group) => group.host)).toEqual(['claude-code'])
  const week = latencyOf(metricsRoute(temp.store.db, '7d', () => T0 + 20_000))
  expect(week.groups.map((group) => [group.host, group.provider, group.runMs.p50])).toEqual([['claude-code', 'claude-cli', 10_000], ['opencode', 'openrouter', 3_000]])
  expect(metricsRoute(temp.store.db, 'forever')).toEqual({ status: 400, body: { error: 'window must be 24h or 7d' } })
})

test('empty stores give null percentiles, and the HTTP route takes and checks ?window', async () => {
  expect(summarizeLatency([], [], '7d', 0).all.runMs).toEqual({ samples: 0, p50: null, p95: null })
  const rig: DashboardRig = startRig(temp.dataDir)
  try {
    expect((await rig.bearer('GET', '/metrics/summary?window=1y')).status).toBe(400)
    const body = (await (await rig.bearer('GET', '/metrics/summary?window=7d')).json()) as { latency: { window: string } }
    expect(body.latency.window).toBe('7d')
  } finally {
    await rig.stop()
  }
})
