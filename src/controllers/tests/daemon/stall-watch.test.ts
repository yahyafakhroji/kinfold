import { afterEach, expect, test } from 'bun:test'
import { type StallWatch, createStallWatch } from '../../daemon/stall-watch'

let watch: StallWatch | null = null
afterEach(() => watch?.stop())

/** Holds the thread, as a long synchronous read does. */
function hold(ms: number): void {
  const until = performance.now() + ms
  while (performance.now() < until) {
    // Spinning on purpose.
  }
}

test('a named step that holds the thread past the threshold logs its name and time', () => {
  const logs: string[] = []
  watch = createStallWatch({ log: (line) => logs.push(line), thresholdMs: 20, intervalMs: 1_000 })
  expect(watch.step('vectors upkeep', () => (hold(40), 7))).toBe(7)
  watch.step('drain', () => {})
  expect(logs).toHaveLength(1)
  expect(logs[0]).toMatch(/^main thread held ms=\d+ by vectors upkeep$/)
})

test('a block outside any named step is logged when the thread comes back, with the steps that ran in it', async () => {
  const logs: string[] = []
  watch = createStallWatch({ log: (line) => logs.push(line), thresholdMs: 60, intervalMs: 10 })
  await Bun.sleep(30)
  setTimeout(() => {
    watch!.step('space step', () => hold(5))
    hold(120)
  }, 0)
  await Bun.sleep(200)
  const line = logs.find((entry) => entry.startsWith('main thread blocked'))
  expect(line).toMatch(/^main thread blocked ms=\d+; named steps in it: space step ms=\d+$/)
})

test('a quiet thread logs nothing', async () => {
  const logs: string[] = []
  watch = createStallWatch({ log: (line) => logs.push(line), thresholdMs: 200, intervalMs: 10 })
  await Bun.sleep(100)
  expect(logs).toEqual([])
})
