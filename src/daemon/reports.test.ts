import { afterEach, beforeEach, expect, test } from 'bun:test'
import { METRICS_MAX_AGE_MS, keptMetricsRoute, metricsRoute } from '../dashboard/metrics'
import { type TempStore, openTempStore } from '../observer/test-support'
import { type StoreReader, inlineStoreReader } from '../workers/store-reader'
import { dataHandlers } from './data-routes'
import { memoryHandlers } from './memory-routes'

let temp: TempStore
let asked: string[]
let reports: StoreReader
beforeEach(() => {
  temp = openTempStore('kinfold-reports-')
  asked = []
  const inline = inlineStoreReader(temp.store.db, temp.store.path)
  reports = { ...inline, run: (op, args, options) => (asked.push(op), inline.run(op, args, options)) }
})
afterEach(() => temp.cleanup())

test('the data size report is read through the reports reader, not on the daemon connection', async () => {
  const handlers = dataHandlers({ db: temp.store.db, dbPath: temp.store.path, markerKey: () => ({ epoch: 1, key: 'k' }) as never, now: Date.now, log: () => {}, reports })
  const report = await handlers.size()
  expect(asked).toEqual(['dataSize'])
  expect(report.totalBytes).toBeGreaterThan(0)
})

test('memory facets and browse are read through the reports reader', async () => {
  const handlers = memoryHandlers(temp.store.db, () => {}, reports)
  await handlers.facets()
  await handlers.browse({ filters: { project: null, host: null, type: null, evidence: null, match: null, offset: 0, limit: 10 } as never, page: 1 })
  expect(asked).toEqual(['memoryFacets', 'memoryBrowse'])
})

test('the metrics summary is read through the reports reader, and a bad window is refused without a read', async () => {
  expect((await metricsRoute(reports, '7d', () => 1_000)).status).toBe(200)
  expect(await metricsRoute(reports, 'forever')).toEqual({ status: 400, body: { error: 'window must be 24h or 7d' } })
  expect(asked).toEqual(['metricsSummary'])
})

test('the kept metrics route reads each window once per max age, however often it is asked, and serves the old summary while a new one is read', async () => {
  let clock = 1_000
  const route = keptMetricsRoute(reports, { now: () => clock })
  const first = await route('7d')
  expect(first.status).toBe(200)
  expect((first.body as { latency: { window: string } }).latency.window).toBe('7d')
  for (let ask = 0; ask < 5; ask += 1) expect(await route('7d')).toEqual(first)
  expect(asked).toEqual(['metricsSummary'])
  await route(null)
  expect(asked).toEqual(['metricsSummary', 'metricsSummary'])
  expect(await route('forever')).toEqual({ status: 400, body: { error: 'window must be 24h or 7d' } })

  clock += METRICS_MAX_AGE_MS + 1
  expect(await route('7d')).toEqual(first)
  expect(asked).toHaveLength(3)
})
