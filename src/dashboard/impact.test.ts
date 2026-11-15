// Impact: what memory costs (measured, per agent) and, from the opt-in
// holdout, what it changes. No estimate of "tokens saved" is made: below a
// minimum sample the comparison says so and draws no conclusion.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { countedEmbedder } from '../daemon/daemon'
import { type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { processSessionBatch } from '../observer/process'
import type { ObserverPrompt, ObserverRunner } from '../observer/types'
import { recordInjection } from '../store/context-store'
import { writeDisplaySettings } from '../store/display-settings'
import { DAY_MS, contextCosts, countEmbeddingCall, embeddingCalls, observerCosts, turnUsageRows } from '../store/impact-reads'
import { insertPrompt, upsertProject, upsertSession } from '../store/writes'
import { MIN_HOLDOUT_SAMPLE, type TurnSample, holdoutComparison, impactSummary, spread } from './impact'
import { metricsSummary } from './metrics'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-impact-')
})
afterEach(() => temp.cleanup())

const HOUR = 3_600_000

function session(host: string, id: string, projectKey = 'org/repo'): number {
  upsertProject(temp.store.db, { key: projectKey, kind: 'git-remote', displayName: projectKey }, T0)
  return upsertSession(temp.store.db, { host, hostSessionId: id, projectKey, cwd: '/w', occurredAt: T0 })
}
function inject(host: string, hostSessionId: string, sessionId: number, channel: 'session_start' | 'prompt', tokens: number, at: number, heldOut = false): void {
  recordInjection(temp.store.db, { sessionId, host, hostSessionId, projectKey: 'org/repo', observationIds: heldOut ? [] : [1], channel, tokens, occurredAt: at, heldOut })
}

test('context cost is per agent: tokens added per session and per prompt, counting prompts that got nothing', () => {
  const db = temp.store.db
  const a = session('claude-code', 'a')
  const b = session('claude-code', 'b')
  const c = session('codex', 'c')
  inject('claude-code', 'a', a, 'session_start', 1000, T0 + 1)
  inject('claude-code', 'b', b, 'session_start', 800, T0 + 2)
  inject('claude-code', 'a', a, 'prompt', 120, T0 + 3)
  inject('claude-code', 'a', a, 'prompt', 0, T0 + 4, true)
  inject('codex', 'c', c, 'session_start', 500, T0 + 5)
  // Before the window: not counted.
  inject('claude-code', 'a', a, 'prompt', 9999, T0 - HOUR)
  for (const n of [1, 2, 3, 4]) insertPrompt(db, { sessionId: a, promptNumber: n, text: 'p', occurredAt: T0 + n })
  insertPrompt(db, { sessionId: c, promptNumber: 1, text: 'p', occurredAt: T0 + 6 })
  insertPrompt(db, { sessionId: c, promptNumber: 2, text: 'old', occurredAt: T0 - HOUR })

  expect(contextCosts(db, T0)).toEqual([
    { host: 'claude-code', sessions: 2, prompts: 4, startTokens: 1800, promptTokens: 120, tokens: 1920, heldOut: 1 },
    { host: 'codex', sessions: 1, prompts: 1, startTokens: 500, promptTokens: 0, tokens: 500, heldOut: 0 },
  ])
})

test('observer tokens are what the runner reported, and a run that reported none says so rather than counting as zero', async () => {
  const db = temp.store.db
  const sid = seedSession(temp.store, 'claude-code', 's1')
  seedEvent(temp.store, sid, { kind: 'user_prompt', at: T0, promptNumber: 1, promptText: 'run the tests' })
  const ids = [seedEvent(temp.store, sid, { kind: 'tool_result', at: T0 + 10, promptNumber: 1, tool: { name: 'Bash', output: '98 pass', exitCode: 0 } })]
  const reply = (prompt: ObserverPrompt): string => JSON.stringify({
    observations: [{ type: 'discovery', title: 'Tests pass', narrative: '', facts: [], files: [], evidence: { strength: 'tool-verified', sourceEventIds: [prompt.eventIds[1] ?? ids[0]] } }],
    summary: { request: 'r', learned: 'l', completed: 'c', nextSteps: 'n' },
  })
  const withUsage: ObserverRunner = {
    run: async (prompt) => ({ text: reply(prompt), model: 'm', usage: { inputTokens: 1200, outputTokens: 300 } }),
  }
  expect((await processSessionBatch({ db, runnerFor: () => withUsage, now: () => T0 + 120_000 }, sid)).status).toBe('succeeded')

  seedEvent(temp.store, sid, { kind: 'user_prompt', at: T0 + 200_000, promptNumber: 2, promptText: 'again' })
  seedEvent(temp.store, sid, { kind: 'tool_result', at: T0 + 200_010, promptNumber: 2, tool: { name: 'Bash', output: '99 pass', exitCode: 0 } })
  expect((await processSessionBatch({ db, runnerFor: () => fakeRunner([reply]), now: () => T0 + 320_000 }, sid)).status).toBe('succeeded')

  expect(db.query('SELECT input_tokens AS i, output_tokens AS o FROM observer_runs ORDER BY id').all()).toEqual([{ i: 1200, o: 300 }, { i: null, o: null }])
  expect(observerCosts(db, T0)).toEqual([{ host: 'claude-code', runs: 2, reported: 1, inputTokens: 1200, outputTokens: 300 }])
  expect(observerCosts(db, T0 + 400_000)).toEqual([])
})

test('embedding calls are counted per day for the whole store, and read over the window', () => {
  const db = temp.store.db
  const day = (n: number): number => T0 + n * DAY_MS
  countEmbeddingCall(db, 16, day(0))
  countEmbeddingCall(db, 4, day(0) + 5)
  countEmbeddingCall(db, 1, day(2))
  expect(db.query('SELECT calls, texts FROM embedding_calls ORDER BY day').all()).toEqual([{ calls: 2, texts: 20 }, { calls: 1, texts: 1 }])
  expect(embeddingCalls(db, day(0) - DAY_MS)).toEqual({ calls: 3, texts: 21 })
  expect(embeddingCalls(db, day(1))).toEqual({ calls: 1, texts: 1 })
  expect(embeddingCalls(db, day(5))).toEqual({ calls: 0, texts: 0 })
})

test('every embedding call the daemon makes is counted when it is made, and a count that fails never stops the call', async () => {
  const db = temp.store.db
  const inner = { model: 'm', dims: 2, embed: async (texts: readonly string[]) => texts.map(() => new Float32Array(2)) }
  const counted = countedEmbedder(db, inner, () => {})
  expect(counted).toMatchObject({ model: 'm', dims: 2 })
  expect((await counted.embed(['a', 'b', 'c'])).length).toBe(3)
  await counted.embed(['query'])
  // A call that fails was still sent.
  const failing = countedEmbedder(db, { ...inner, embed: async () => { throw new Error('timeout') } }, () => {})
  await expect(failing.embed(['x'])).rejects.toThrow('timeout')
  expect(embeddingCalls(db, 0)).toEqual({ calls: 3, texts: 5 })

  const logs: string[] = []
  db.run('DROP TABLE embedding_calls')
  expect((await countedEmbedder(db, inner, (line) => logs.push(line)).embed(['y'])).length).toBe(1)
  expect(logs).toHaveLength(1)
  expect(logs[0]).toStartWith('embedding call not counted')
})

// --- the holdout comparison ---

const sample = (heldOut: boolean, tokens: number, toolCalls = 2, durationMs: number | null = 10_000, projectKey = 'org/repo'): TurnSample =>
  ({ heldOut, projectKey, tokens, outputTokens: Math.round(tokens / 10), toolCalls, durationMs })

test('spread is the median and the quartiles, in plain numbers', () => {
  expect(spread([])).toEqual({ n: 0, median: null, low: null, high: null })
  expect(spread([10])).toEqual({ n: 1, median: 10, low: 10, high: 10 })
  expect(spread([40, 10, 30, 20])).toEqual({ n: 4, median: 25, low: 17.5, high: 32.5 })
  expect(spread([1, 2, 3, 4, 100])).toEqual({ n: 5, median: 3, low: 2, high: 4 })
})

test('below thirty turns in either group the comparison says "not enough turns yet" and gives no numbers to compare', () => {
  expect(MIN_HOLDOUT_SAMPLE).toBe(30)
  const few = holdoutComparison([...Array.from({ length: 200 }, () => sample(false, 1000)), ...Array.from({ length: 29 }, () => sample(true, 5000))])
  expect(few).toEqual({ enough: false, minSample: 30, heldOut: 29, normal: 200, recorded: { heldOut: 29, normal: 200 }, metrics: [] })
  expect(holdoutComparison([])).toEqual({ enough: false, minSample: 30, heldOut: 0, normal: 0, recorded: { heldOut: 0, normal: 0 }, metrics: [] })
})

test('with enough turns each measure is reported for both groups, with its sample size, and no verdict', () => {
  const normal = Array.from({ length: 40 }, (_, index) => sample(false, 1000 + index * 10, 2, 8_000))
  const held = Array.from({ length: 30 }, (_, index) => sample(true, 2000 + index * 10, 5, null))
  const result = holdoutComparison([...normal, ...held])
  expect(result).toMatchObject({ enough: true, heldOut: 30, normal: 40 })
  expect(result.metrics.map((metric) => metric.name)).toEqual(['tokens', 'outputTokens', 'toolCalls', 'durationMs'])
  const tokens = result.metrics[0]!
  expect(tokens.normal).toEqual({ n: 40, median: 1195, low: 1097.5, high: 1292.5 })
  expect(tokens.heldOut).toEqual({ n: 30, median: 2145, low: 2072.5, high: 2217.5 })
  // Turns whose time could not be read are left out of that one measure, and its n shows it.
  expect(result.metrics[3]!.heldOut).toEqual({ n: 0, median: null, low: null, high: null })
  expect(result.metrics[3]!.normal.n).toBe(40)
  expect(JSON.stringify(result)).not.toMatch(/saved|better|worse/)
})

test('only projects that have turns of both kinds are compared', () => {
  const rows = [
    ...Array.from({ length: 30 }, () => sample(false, 1000, 2, 1, 'org/a')),
    ...Array.from({ length: 30 }, () => sample(true, 3000, 2, 1, 'org/a')),
    // A project that was never held out would only shift the normal group.
    ...Array.from({ length: 500 }, () => sample(false, 9, 2, 1, 'org/b')),
  ]
  const result = holdoutComparison(rows)
  expect(result).toMatchObject({ enough: true, heldOut: 30, normal: 30, recorded: { heldOut: 30, normal: 530 } })
  expect(result.metrics[0]!.normal.median).toBe(1000)
})

test('the metrics summary carries the impact block: costs over the window, the date they count from, and the comparison', () => {
  const db = temp.store.db
  const a = session('claude-code', 'a')
  inject('claude-code', 'a', a, 'session_start', 700, T0 + 1)
  insertPrompt(db, { sessionId: a, promptNumber: 1, text: 'p', occurredAt: T0 + 2 })
  countEmbeddingCall(db, 3, T0 + 3)
  db.run(`INSERT INTO turn_usage (session_id, prompt_number, host, project_key, held_out, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_calls, duration_ms, occurred_at)
    VALUES (${a}, 1, 'claude-code', 'org/repo', 1, 10, 20, 300, 40, 3, 5000, ${T0 + 4})`)
  expect(turnUsageRows(db)).toEqual([{ heldOut: true, projectKey: 'org/repo', tokens: 370, outputTokens: 20, toolCalls: 3, durationMs: 5000 }])

  const impact = impactSummary(db, T0, '24h')
  expect(impact.context).toEqual([{ host: 'claude-code', sessions: 1, prompts: 1, startTokens: 700, promptTokens: 0, tokens: 700, heldOut: 0, tokensPerSession: 700, tokensPerPrompt: 0 }])
  expect(impact.embedding).toEqual({ calls: 1, texts: 3 })
  expect(impact.observer).toEqual([])
  expect(typeof impact.countingSince).toBe('number')
  // One held-out turn and no normal one in its project: recorded, nothing to compare yet.
  expect(impact.holdout).toMatchObject({ on: false, hosts: ['claude-code'], comparison: { enough: false, heldOut: 0, normal: 0, recorded: { heldOut: 1, normal: 0 } } })

  writeDisplaySettings(db, { holdout: true }, T0)
  const summary = metricsSummary(db, '24h', T0 + HOUR)
  expect(summary.impact.holdout.on).toBe(true)
  expect(summary.impact.window).toBe('24h')
  // The hit-rate proxies stay, with their caveat on the page.
  expect(summary.hitRate.fetchAfterInject).toBeDefined()
})
