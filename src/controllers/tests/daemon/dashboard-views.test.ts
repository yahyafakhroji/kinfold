import { expect, test } from 'bun:test'
import type { Database } from '../../../resources/sqlite/types'
import type { StoreReader } from '../../../resources/workers/store-reader'
import { dashboardViews } from '../../daemon/dashboard-views'

/** A reports reader that counts what it computes and answers at once. */
function countingReader() {
  const runs: string[] = []
  const reader = {
    run: async (op: string) => {
      runs.push(op)
      return op === 'measuredSaving' ? [] : { op }
    },
    hold: async () => () => {},
    close: async () => {},
  } as unknown as StoreReader
  return { reader, runs }
}

test('warm computes the kept reports ahead of the first page, so that page computes nothing', async () => {
  const { reader, runs } = countingReader()
  const views = dashboardViews({} as Database, reader, { now: () => 1_000 })
  await views.warm()
  expect(runs.sort()).toEqual(['impactReport', 'impactReport', 'measuredSaving', 'overviewReport'])
  runs.length = 0
  for (const path of ['/memory/overview', '/memory/impact?window=7d', '/memory/impact?window=30d']) {
    const answer = await views('GET', new URL(`http://x${path}`))
    expect(answer).toMatchObject({ status: 200, body: { asOf: 1_000, refreshing: false } })
  }
  expect(runs).toEqual([])
})

test('a failed warm-up is logged and leaves the first page ask to compute', async () => {
  const lines: string[] = []
  const reader = { run: async () => { throw new Error('reader stopped') }, hold: async () => () => {}, close: async () => {} } as unknown as StoreReader
  const views = dashboardViews({} as Database, reader, { log: (line) => lines.push(line) })
  await views.warm()
  expect(lines.some((line) => line.startsWith('dashboard report warm-up failed'))).toBe(true)
})

test('after rows are removed the kept reports are computed again on the next ask, not served from before', async () => {
  const { reader, runs } = countingReader()
  const views = dashboardViews({} as Database, reader, { now: () => 1_000 })
  await views.warm()
  runs.length = 0
  views.invalidate()
  expect(await views('GET', new URL('http://x/memory/overview'))).toMatchObject({ status: 200, body: { refreshing: false } })
  expect(runs.sort()).toEqual(['measuredSaving', 'overviewReport'])
  runs.length = 0
  expect(await views('GET', new URL('http://x/memory/impact?window=7d'))).toMatchObject({ status: 200 })
  // The saving figures were recomputed once, for the overview; the impact report reuses them.
  expect(runs).toEqual(['impactReport'])
})
