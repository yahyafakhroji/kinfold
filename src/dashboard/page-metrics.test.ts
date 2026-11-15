import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, type FakeNode, elements, fakeDocument, textNodes } from './fake-dom'
import type { MetricsSummary, StagePercentiles } from './metrics'
import { PUBLIC_DIR } from './routes'

type Hash = { page: string; params: Record<string, string> }
interface MetricsPage {
  latencyBlock(summary: MetricsSummary, state: Hash): FakeElement
  usageBlock(summary: MetricsSummary): FakeElement
  impactBlock(summary: MetricsSummary): FakeElement
  renderMetrics(state?: Hash): Promise<FakeElement>
  windowOf(state: Hash): string
}

const load = async (): Promise<MetricsPage> => (await import(join(PUBLIC_DIR, 'page-metrics.js'))) as MetricsPage
const p = (p50: number | null, p95: number | null, samples = 3) => ({ samples, p50, p95 })
const stages = (scale: number): StagePercentiles => ({
  ingestMs: p(50 * scale, 600 * scale), schedulerMs: p(19_000 * scale, 108_000 * scale), runMs: p(12_000 * scale, 20_000 * scale),
  writeMs: p(0, 0), lagFromEventMs: p(35_000 * scale, 122_000 * scale), lagFromTurnEndMs: p(14_000 * scale, 21_000 * scale, 2),
})
const SUMMARY: MetricsSummary = {
  runs: [], injections: [], captureLagMs: p(null, null, 0), queue: [],
  latency: { window: '7d', since: 0, all: stages(1), groups: [{ host: 'claude-code', provider: 'claude-cli', ...stages(1) }, { host: 'opencode', provider: 'openrouter', ...stages(2) }] },
  injectionLatency: [{ host: 'claude-code', channel: 'prompt', durationMs: p(2, 9, 12) }, { host: 'opencode', channel: 'request', durationMs: p(1, 4, 5) }],
  hitRate: {
    window: '7d', since: 0,
    fetchAfterInject: { injected: 40, fetched: 6, rate: 0.15, horizonMs: 86_400_000 },
    searchHit: { searches: 8, withRows: 6, rate: 0.75 },
    reads: [{ host: 'claude-code', tool: 'get_observations', calls: 7, errors: 0 }, { host: 'unknown', tool: 'search', calls: 9, errors: 1 }],
    relatedByDistance: [{ band: '0.00-0.35', served: 12, fetched: 3, rate: 0.25 }, { band: 'keyword only', served: 0, fetched: 0, rate: null }],
  },
  impact: {
    window: '7d', since: 0, countingSince: Date.UTC(2026, 10, 15),
    context: [
      { host: 'claude-code', sessions: 4, prompts: 20, startTokens: 6000, promptTokens: 1000, tokens: 7000, heldOut: 2, tokensPerSession: 1750, tokensPerPrompt: 50 },
      { host: 'cursor', sessions: 0, prompts: 3, startTokens: 0, promptTokens: 0, tokens: 0, heldOut: 0, tokensPerSession: null, tokensPerPrompt: 0 },
    ],
    observer: [{ host: 'claude-code', runs: 5, reported: 4, inputTokens: 42_000, outputTokens: 3_100 }, { host: 'codex', runs: 2, reported: 0, inputTokens: 0, outputTokens: 0 }],
    embedding: { calls: 12, texts: 96 },
    holdout: { on: true, hosts: ['claude-code'], comparison: { enough: false, minSample: 30, heldOut: 4, normal: 31, recorded: { heldOut: 4, normal: 40 }, metrics: [] } },
  },
}

let saved: { document: unknown; fetch: unknown }
const requested: string[] = []
beforeAll(() => {
  const globals = globalThis as Record<string, unknown>
  saved = { document: globals.document, fetch: globals.fetch }
  globals.document = fakeDocument()
  globals.fetch = async (path: string) => {
    requested.push(path)
    return new Response(JSON.stringify(SUMMARY), { status: 200, headers: { 'content-type': 'application/json' } })
  }
})
afterAll(() => {
  const globals = globalThis as Record<string, unknown>
  globals.document = saved.document
  globals.fetch = saved.fetch
})

const text = (root: FakeNode): string => textNodes(root).map((node) => node.textContent).join('|')

test('the latency block shows both lag numbers and one stage row per group, as text', async () => {
  const page = await load()
  const block = page.latencyBlock(SUMMARY, { page: 'metrics', params: { window: '7d' } })
  const shown = text(block)
  for (const label of ['from turn end p50', 'from turn end p95', 'from event p50', 'from event p95', 'Context injection']) expect(shown).toContain(label)
  expect(shown).not.toContain('not recorded yet')
  expect(shown).toContain('Last 7d.')
  expect(shown).toContain('2 turns')
  const tables = elements(block).filter((element) => element.tagName === 'TABLE')
  expect(tables).toHaveLength(2)
  const rows = elements(tables[0]!).filter((element) => element.tagName === 'TR')
  expect(rows).toHaveLength(4)
  expect(text(rows[1]!)).toStartWith('all|')
  expect(text(rows[3]!)).toStartWith('opencode|openrouter|')
})

test('window links point at hash states and mark the current one', async () => {
  const page = await load()
  const links = elements(page.latencyBlock(SUMMARY, { page: 'metrics', params: { window: '7d' } })).filter((element) => element.tagName === 'A')
  expect(links.map((link) => link.getAttribute('href'))).toEqual(['#metrics?window=24h', '#metrics?window=7d'])
  expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page'])
  expect(page.windowOf({ page: 'metrics', params: { window: '1y' } })).toBe('24h')
})

test('renderMetrics asks for the window in the hash and adds the latency block', async () => {
  const page = await load()
  const root = await page.renderMetrics({ page: 'metrics', params: { window: '7d' } })
  expect(requested.at(-1)).toBe('/metrics/summary?window=7d')
  expect(elements(root).some((element) => element.getAttribute('aria-label') === 'Latency')).toBe(true)
  await page.renderMetrics()
  expect(requested.at(-1)).toBe('/metrics/summary?window=24h')
})

test('the latency block lists injection p50/p95 per host and channel, as text', async () => {
  const page = await load()
  const tables = elements(page.latencyBlock(SUMMARY, { page: 'metrics', params: {} })).filter((element) => element.tagName === 'TABLE')
  const rows = elements(tables[1]!).filter((element) => element.tagName === 'TR')
  expect(rows.map((row) => text(row))).toEqual(['Host|Channel|Injections|p50|p95', 'claude-code|prompt|12|2 ms|9 ms', 'opencode|request|5|1 ms|4 ms'])
})

test('the impact block shows measured costs per agent, where they count from, and no estimate of savings', async () => {
  const page = await load()
  const block = page.impactBlock(SUMMARY)
  const shown = text(block)
  expect(shown).toContain('Impact')
  expect(shown).toContain('Last 7d. Counting since 2026-11-15')
  const rows = elements(block).filter((element) => element.tagName === 'TR').map((row) => text(row))
  expect(rows).toContain('Agent|Sessions|Prompts|Tokens added|Per session|Per prompt')
  expect(rows).toContain('claude-code|4|20|7,000|1,750|50')
  // No session got memory: a dash, not a zero that reads as a measurement.
  expect(rows).toContain('cursor|0|3|0|—|0')
  expect(rows).toContain('Agent|Runs|Reported usage|Input tokens|Output tokens')
  expect(rows).toContain('claude-code|5|4 of 5|42,000|3,100')
  expect(rows).toContain('codex|2|0 of 2|—|—')
  expect(shown).toContain('embedding calls')
  expect(shown).toContain('12')
  expect(shown).toContain('96 texts, for the whole store')
  expect(shown).not.toMatch(/tokens saved|saved you/i)
})

test('with the impact test on and too few turns the block says so and compares nothing', async () => {
  const page = await load()
  const shown = text(page.impactBlock(SUMMARY))
  expect(shown).toContain('Impact test: on for claude-code')
  expect(shown).toContain('Not enough turns yet: 4 held out and 31 with memory, and 30 of each are needed before the two are compared.')
  expect(shown).toContain('Recorded so far: 4 held out, 40 with memory.')
  expect(shown).not.toContain('Median')
})

test('with enough turns the block sets the two groups side by side, with sample sizes and no verdict', async () => {
  const page = await load()
  const spreadOf = (median: number, n = 40) => ({ n, median, low: median * 0.8, high: median * 1.2 })
  const enough: MetricsSummary = { ...SUMMARY, impact: { ...SUMMARY.impact, holdout: { on: true, hosts: ['claude-code'], comparison: {
    enough: true, minSample: 30, heldOut: 32, normal: 40, recorded: { heldOut: 32, normal: 300 },
    metrics: [
      { name: 'tokens', heldOut: spreadOf(52_000, 32), normal: spreadOf(41_000) },
      { name: 'outputTokens', heldOut: spreadOf(900, 32), normal: spreadOf(800) },
      { name: 'toolCalls', heldOut: spreadOf(6, 32), normal: spreadOf(4) },
      { name: 'durationMs', heldOut: { n: 0, median: null, low: null, high: null }, normal: spreadOf(42_000) },
    ],
  } } } }
  const block = page.impactBlock(enough)
  const rows = elements(block).filter((element) => element.tagName === 'TR').map((row) => text(row))
  expect(rows).toContain('Per turn|Without memory (held out)|With memory')
  expect(rows).toContain('Tokens|52,000 (41,600 to 62,400), 32 turns|41,000 (32,800 to 49,200), 40 turns')
  expect(rows).toContain('Tool calls|6 (4.8 to 7.2), 32 turns|4 (3.2 to 4.8), 40 turns')
  expect(rows).toContain('Time|—, 0 turns|42.0 s (33.6 s to 50.4 s), 40 turns')
  const shown = text(block)
  expect(shown).toContain('Median, with the middle half of turns in brackets.')
  expect(shown).not.toMatch(/saved|better|worse|faster/i)
})

test('with the impact test off the block says how to turn it on, and that it is opt-in', async () => {
  const page = await load()
  const off: MetricsSummary = { ...SUMMARY, impact: { ...SUMMARY.impact, countingSince: null, holdout: { on: false, hosts: ['claude-code'], comparison: { enough: false, minSample: 30, heldOut: 0, normal: 0, recorded: { heldOut: 0, normal: 0 }, metrics: [] } } } }
  const shown = text(page.impactBlock(off))
  expect(shown).toContain('Impact test: off.')
  expect(shown).toContain('kinfold install --holdout')
  expect(shown).not.toContain('Counting since')
  expect(shown).not.toContain('Not enough turns yet')
})

test('the memory-use block shows both proxies, says they are proxies, and lists reads per host and tool', async () => {
  const page = await load()
  const block = page.usageBlock(SUMMARY)
  const shown = text(block)
  for (const label of ['Memory use (proxies)', 'fetch after inject', '15%', '6 of 40 injected ids', 'search hit', '75%', '6 of 8 searches', 'Last 7d.', 'These are proxies, not usage.', 'Related lines by distance', '0.00-0.35', '25%']) {
    expect(shown).toContain(label)
  }
  const rows = elements(block).filter((element) => element.tagName === 'TR').map((row) => text(row))
  expect(rows.slice(0, 3)).toEqual(['Host|Tool|Calls|Errors', 'claude-code|get_observations|7|0', 'unknown|search|9|1'])
  expect(rows.slice(3, 5)).toEqual(['Distance|Served|Fetched|Rate', '0.00-0.35|12|3|25%'])
  const root = await page.renderMetrics({ page: 'metrics', params: {} })
  expect(elements(root).some((element) => element.getAttribute('aria-label') === 'Memory use')).toBe(true)
})
