import { expect, test } from 'bun:test'
import { keptReport } from './kept-report'

function controlled() {
  let calls = 0
  let release: ((value: number) => void) | null = null
  const compute = (): Promise<number> => {
    calls += 1
    return new Promise((resolve) => {
      release = resolve
    })
  }
  return { compute, calls: () => calls, finish: (value: number) => release?.(value) }
}

test('the first ask waits for the report; later asks share one computation', async () => {
  let now = 1_000
  const work = controlled()
  const report = keptReport(work.compute, { maxAgeMs: 60_000, now: () => now })
  const first = report.get()
  const second = report.get()
  expect(work.calls()).toBe(1)
  work.finish(7)
  expect(await first).toEqual({ value: 7, asOf: 1_000, refreshing: false })
  expect(await second).toEqual({ value: 7, asOf: 1_000, refreshing: false })
  now += 30_000
  expect(await report.get()).toEqual({ value: 7, asOf: 1_000, refreshing: false })
  expect(work.calls()).toBe(1)
})

test('a stale report is answered at once and refreshed behind it', async () => {
  let now = 0
  const work = controlled()
  const report = keptReport(work.compute, { maxAgeMs: 10, now: () => now })
  const first = report.get()
  work.finish(1)
  await first
  now = 50
  expect(await report.get()).toEqual({ value: 1, asOf: 0, refreshing: true })
  expect(work.calls()).toBe(2)
  work.finish(2)
  await Bun.sleep(0)
  expect(await report.get()).toEqual({ value: 2, asOf: 50, refreshing: false })
})

test('a failed refresh keeps the last good report; a failed first ask rejects and the next one tries again', async () => {
  let fail = true
  let now = 0
  const report = keptReport(async () => {
    if (fail) throw new Error('reader stopped')
    return now
  }, { maxAgeMs: 10, now: () => now })
  expect(report.get()).rejects.toThrow('reader stopped')
  await Bun.sleep(0)
  fail = false
  expect(await report.get()).toEqual({ value: 0, asOf: 0, refreshing: false })
  fail = true
  now = 100
  expect(await report.get()).toMatchObject({ value: 0, refreshing: true })
  await Bun.sleep(0)
  expect(await report.get()).toMatchObject({ value: 0, asOf: 0 })
})

test('invalidate makes the next ask compute again', async () => {
  let n = 0
  const report = keptReport(async () => ++n, { maxAgeMs: 60_000, now: () => 0 })
  expect((await report.get()).value).toBe(1)
  report.invalidate()
  expect((await report.get()).value).toBe(2)
})

test('after invalidate the next ask waits for a value computed from then on, not for one already under way', async () => {
  const now = 1_000
  const finish: ((value: number) => void)[] = []
  let running = 0
  let most = 0
  const report = keptReport<number>(() => {
    running += 1
    most = Math.max(most, running)
    return new Promise<number>((resolve) => finish.push(resolve)).finally(() => {
      running -= 1
    })
  }, { maxAgeMs: 60_000, now: () => now })

  // A computation is under way when rows are purged: it read the store before the purge.
  const before = report.get()
  await Promise.resolve()
  report.invalidate()
  const after = report.get()
  finish[0]!(100)
  expect(await before).toEqual({ value: 100, asOf: 1_000, refreshing: false })
  // The second computation starts only once the first has ended, and its value is the one handed out.
  for (let turn = 0; turn < 5 && finish.length < 2; turn += 1) await Promise.resolve()
  expect(finish).toHaveLength(2)
  finish[1]!(60)
  expect(await after).toEqual({ value: 60, asOf: 1_000, refreshing: false })
  expect(most).toBe(1)
  // The stale value did not mark the report fresh: a later ask gets 60, with no third computation.
  expect(await report.get()).toEqual({ value: 60, asOf: 1_000, refreshing: false })
  expect(finish).toHaveLength(2)

  // A failed computation from before the invalidation does not stop the next one.
  report.invalidate()
  const third = report.get()
  for (let turn = 0; turn < 5 && finish.length < 3; turn += 1) await Promise.resolve()
  finish[2]!(40)
  expect((await third).value).toBe(40)
})

test('a computation that throws before it returns a promise fails that ask with its own error, and the next ask computes again', async () => {
  let calls = 0
  const report = keptReport<number>(() => {
    calls += 1
    if (calls === 1) throw new Error('store closed')
    return Promise.resolve(7)
  }, { maxAgeMs: 60_000, now: () => 1_000 })
  await expect(report.get()).rejects.toThrow('store closed')
  expect(await report.get()).toEqual({ value: 7, asOf: 1_000, refreshing: false })
  expect(calls).toBe(2)
})
