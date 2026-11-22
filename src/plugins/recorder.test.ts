import { expect, test } from 'bun:test'
import type { NormalizedEvent } from '../contract/event'
import { createPluginRecorder } from './recorder'

const event = (eventId: string): NormalizedEvent => ({ eventId }) as NormalizedEvent
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

test('a burst of events is spooled one by one at once and nudges the daemon once', async () => {
  const spooled: string[] = []
  let nudges = 0
  const recorder = createPluginRecorder({
    dataDir: '/data',
    coalesceMs: 5,
    onNudgeSkipped: () => {},
    spool: (item) => (spooled.push(item.eventId), item.eventId),
    nudge: async () => ((nudges += 1), { ok: true }),
  })
  for (const id of ['a', 'b', 'c']) recorder.record(event(id))
  // On disk before the hook returns, with no nudge sent yet.
  expect(spooled).toEqual(['a', 'b', 'c'])
  expect(nudges).toBe(0)
  await wait(30)
  expect(nudges).toBe(1)
  // A later event starts a new burst.
  recorder.record(event('d'))
  await wait(30)
  expect(nudges).toBe(2)
})

test('a nudge that did not reach the daemon is reported once, with the events it stood for', async () => {
  const skipped: [string, number][] = []
  const recorder = createPluginRecorder({
    dataDir: '/data',
    coalesceMs: 5,
    onNudgeSkipped: (reason, events) => skipped.push([reason, events]),
    spool: () => 'path',
    nudge: async () => ({ ok: false, reason: 'daemon not running' }),
  })
  recorder.record(event('a'))
  recorder.record(event('b'))
  await wait(30)
  expect(skipped).toEqual([['daemon not running', 2]])
})

test('an event that cannot be spooled throws to the caller and schedules no nudge', async () => {
  let nudges = 0
  const recorder = createPluginRecorder({
    dataDir: '/data',
    coalesceMs: 5,
    onNudgeSkipped: () => {},
    spool: () => {
      throw new Error('disk full')
    },
    nudge: async () => ((nudges += 1), { ok: true }),
  })
  expect(() => recorder.record(event('a'))).toThrow('disk full')
  await wait(30)
  expect(nudges).toBe(0)
})
