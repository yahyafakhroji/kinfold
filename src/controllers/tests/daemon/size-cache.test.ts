import { expect, test } from 'bun:test'
import { SizeStillComputingError, createSizeCache } from './size-cache'

/** A size read that takes `ms` and answers with how many reads ran so far. */
function slowRead(ms: number) {
  let reads = 0
  return {
    get reads() {
      return reads
    },
    run: async (): Promise<{ n: number }> => {
      reads += 1
      const n = reads
      await Bun.sleep(ms)
      return { n }
    },
  }
}

test('a size report slower than the wait is not waited on: the caller hears it is being worked out, then gets it at once', async () => {
  const read = slowRead(150)
  let clock = 0
  const cache = createSizeCache(read.run, { now: () => clock, waitMs: 30, freshMs: 60_000 })
  const startedAt = performance.now()
  await expect(cache.get()).rejects.toBeInstanceOf(SizeStillComputingError)
  expect(performance.now() - startedAt).toBeLessThan(120)
  await Bun.sleep(200)
  const early = performance.now()
  expect(await cache.get()).toEqual({ report: { n: 1 }, measuredAt: 0 })
  expect(performance.now() - early).toBeLessThan(20)
  expect(read.reads).toBe(1)
})

test('a stale report is answered at once while a fresh one is worked out behind it', async () => {
  const read = slowRead(100)
  let clock = 0
  const cache = createSizeCache(read.run, { now: () => clock, waitMs: 500, freshMs: 1_000 })
  expect((await cache.get()).report).toEqual({ n: 1 })
  clock = 5_000
  const startedAt = performance.now()
  expect(await cache.get()).toEqual({ report: { n: 1 }, measuredAt: 0 })
  expect(performance.now() - startedAt).toBeLessThan(50)
  await Bun.sleep(150)
  expect(await cache.get()).toEqual({ report: { n: 2 }, measuredAt: 5_000 })
  // Asked while one runs, a read is never started twice.
  expect(read.reads).toBe(2)
})

test('a failed read is told to the caller once, and the next ask tries again', async () => {
  let fail = true
  const cache = createSizeCache(async () => {
    if (fail) throw new Error('the read failed')
    return { n: 1 }
  }, { now: () => 0, waitMs: 100, freshMs: 1_000 })
  await expect(cache.get()).rejects.toThrow('the read failed')
  fail = false
  expect((await cache.get()).report).toEqual({ n: 1 })
})

test('a report marked stale (after a purge or retention) is answered once more while a new one is read', async () => {
  const read = slowRead(50)
  const cache = createSizeCache(read.run, { now: () => 0, waitMs: 500, freshMs: 60_000 })
  expect((await cache.get()).report).toEqual({ n: 1 })
  cache.stale()
  expect((await cache.get()).report).toEqual({ n: 1 })
  await Bun.sleep(100)
  expect((await cache.get()).report).toEqual({ n: 2 })
})
