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
