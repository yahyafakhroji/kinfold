import { afterEach, beforeEach, expect, test } from 'bun:test'
import { recordInjection } from '../store/context-store'
import { finishRun, insertObservation, markDone, markFailed, startRun } from '../store/observer-store'
import { PROJECT, T0, type TempStore, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { errorClassOf, groupRuns, metricsSummary, percentile } from './metrics'
import { type DashboardRig, startRig } from './test-support'

let temp: TempStore
let session: number

beforeEach(() => {
  temp = openTempStore('sam-dashboard-metrics-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
})
afterEach(() => temp.cleanup())

function run(host: string, provider: string, ms: number, error: string | null): void {
  const id = startRun(temp.store.db, { sessionId: session, host, provider, model: 'm', eventCount: 1, startedAt: T0 })
  finishRun(temp.store.db, id, error === null ? 'succeeded' : 'failed', error, T0 + ms)
}

function observationCiting(eventIds: string[], createdAt: number, title: string): void {
  insertObservation(temp.store.db, {
    projectKey: PROJECT, sessionId: session, host: 'claude-code', promptNumber: 1, type: 'discovery', title, narrative: '', facts: '[]', files: '[]',
    evidence: 'tool-verified', sourceEventIds: JSON.stringify(eventIds), observerModel: 'm', contentHash: title, occurredAt: createdAt, createdAt,
  })
}

test('percentile is nearest-rank and null for no samples', () => {
  expect(percentile([], 0.5)).toBeNull()
  expect(percentile([5], 0.95)).toBe(5)
  expect(percentile([10, 1, 4, 3, 2, 9, 8, 7, 6, 5], 0.5)).toBe(5)
  expect(percentile([10, 1, 4, 3, 2, 9, 8, 7, 6, 5], 0.95)).toBe(10)
  expect(percentile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95)
})

test('a stored run error becomes its class, anything else "other"', () => {
  expect(errorClassOf('timeout: claude ran past 120000 ms')).toBe('timeout')
  expect(errorClassOf('interrupted: daemon stopped mid-run')).toBe('interrupted')
  expect(errorClassOf('sk-or-v1-something leaked: here')).toBe('other')
  expect(errorClassOf(null)).toBe('other')
})

test('runs group per host and provider with success rate, p50/p95 and error classes', () => {
  for (const ms of [100, 200, 300, 400]) run('claude-code', 'claude-cli', ms, null)
  run('claude-code', 'claude-cli', 5_000, 'timeout: ran past the limit')
  run('opencode', 'openrouter', 50, 'http_error: status 402')
  run('opencode', 'openrouter', 70, 'http_error: status 402')
  run('opencode', 'openrouter', 90, 'bad_output: no JSON object')
  run('opencode', 'openrouter', 30, null)
  startRun(temp.store.db, { sessionId: session, host: 'opencode', provider: 'openrouter', model: 'm', eventCount: 1, startedAt: T0 })

  const summary = metricsSummary(temp.store.db)
  expect(summary.runs).toEqual([
    { host: 'claude-code', provider: 'claude-cli', runs: 5, succeeded: 4, failed: 1, running: 0, successRate: 0.8, durationMs: { samples: 5, p50: 300, p95: 5_000 }, errorClasses: { timeout: 1 } },
    { host: 'opencode', provider: 'openrouter', runs: 5, succeeded: 1, failed: 3, running: 1, successRate: 0.25, durationMs: { samples: 4, p50: 50, p95: 90 }, errorClasses: { http_error: 2, bad_output: 1 } },
  ])
  expect(JSON.stringify(summary)).not.toContain('status 402')
  expect(groupRuns([])).toEqual([])
})

test('injections per host and channel, capture lag and the queue by state', () => {
  const inject = (host: string, channel: 'session_start' | 'request', tokens: number): number =>
    recordInjection(temp.store.db, { sessionId: session, host, hostSessionId: 'cc-1', projectKey: PROJECT, observationIds: [], channel, tokens, occurredAt: T0 })
  inject('claude-code', 'session_start', 400)
  inject('claude-code', 'session_start', 600)
  inject('claude-code', 'request', 50)
  inject('opencode', 'session_start', 300)

  const events = [0, 1, 2, 3].map((n) => seedEvent(temp.store, session, { kind: 'tool_result', at: T0 + n * 1_000, tool: { name: 'Bash', output: 'x', exitCode: 0 } }))
  markDone(temp.store.db, events.slice(0, 2))
  markFailed(temp.store.db, [events[2]!], T0)
  observationCiting([events[0]!, events[1]!], T0 + 1_000 + 4_000, 'cites two, newest at +1 s: lag 4 s')
  observationCiting([events[2]!], T0 + 2_000 + 10_000, 'lag 10 s')
  observationCiting([events[3]!], T0 + 3_000 + 30_000, 'lag 30 s')
  observationCiting(['01PURGEDEVENTID000000000000'], T0 + 99_000, 'cites nothing that exists: left out')

  const summary = metricsSummary(temp.store.db)
  expect(summary.injections).toEqual([
    { host: 'claude-code', channel: 'request', count: 1, tokens: 50 },
    { host: 'claude-code', channel: 'session_start', count: 2, tokens: 1_000 },
    { host: 'opencode', channel: 'session_start', count: 1, tokens: 300 },
  ])
  expect(summary.captureLagMs).toEqual({ samples: 3, p50: 10_000, p95: 30_000 })
  expect(summary.queue).toEqual([{ state: 'done', events: 2 }, { state: 'failed', events: 1 }, { state: 'pending', events: 1 }])
})

test('GET /metrics/summary answers the same numbers over HTTP', async () => {
  run('claude-code', 'claude-cli', 120, null)
  const rig: DashboardRig = startRig(temp.dataDir)
  try {
    const response = await rig.bearer('GET', '/metrics/summary')
    expect(response.status).toBe(200)
    const { latency, hitRate, injectionLatency, ...rest } = (await response.json()) as Record<string, unknown>
      & { latency: { window: string; groups: unknown[] }; hitRate: { window: string; reads: unknown[] }; injectionLatency: unknown[] }
    expect(rest).toEqual({
      runs: [{ host: 'claude-code', provider: 'claude-cli', runs: 1, succeeded: 1, failed: 0, running: 0, successRate: 1, durationMs: { samples: 1, p50: 120, p95: 120 }, errorClasses: {} }],
      injections: [],
      captureLagMs: { samples: 0, p50: null, p95: null },
      queue: [],
    })
    expect(latency.window).toBe('24h')
    expect(latency.groups).toEqual([])
    expect(hitRate).toMatchObject({ window: '24h', reads: [], fetchAfterInject: { injected: 0, fetched: 0, rate: null }, searchHit: { searches: 0, rate: null } })
    expect(injectionLatency).toEqual([])
    expect((await rig.bearer('POST', '/metrics/summary')).status).toBe(405)
  } finally {
    await rig.stop()
  }
})
