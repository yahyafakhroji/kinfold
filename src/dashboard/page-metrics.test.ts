import { afterAll, beforeAll, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type FakeElement, type FakeNode, elements, fakeDocument, textNodes } from './fake-dom'
import type { MetricsSummary, StagePercentiles } from './metrics'
import { PUBLIC_DIR } from './routes'

type Hash = { page: string; params: Record<string, string> }
interface MetricsPage {
  latencyBlock(summary: MetricsSummary, state: Hash): FakeElement
  usageBlock(summary: MetricsSummary): FakeElement
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
