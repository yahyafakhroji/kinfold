import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { BatchOutcome } from '../observer/process'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import { DEFAULT_SCHEDULE, LEGACY_SCHEDULE, createObserverScheduler, dueReason, parseIdleMs, parseMaxWaitMs, shouldObserve } from './observer-scheduler'

let temp: TempStore
let clock: number
let started: number[]
let release: Map<number, () => void>
beforeEach(() => {
  temp = openTempStore('sam-observer-sched-')
  clock = T0
  started = []
  release = new Map()
})
afterEach(() => temp.cleanup())

/** A fake batch that marks the session's events done when released, like a real success would. */
function processSession(sessionId: number): Promise<BatchOutcome> {
  started.push(sessionId)
  return new Promise((resolve) => {
    release.set(sessionId, () => {
      temp.store.db.run(`UPDATE events SET observer_state = 'done' WHERE session_id = ${sessionId}`)
      resolve({ status: 'succeeded', runId: 1, events: 1, echoes: 0, droppedRelations: 0, observations: 0, inserted: 0, downgraded: 0, summary: false, links: 0, contradicted: 0 })
    })
  })
}

function scheduler(logs: string[] = []) {
  return createObserverScheduler({ db: temp.store.db, processSession, now: () => clock, log: (line) => logs.push(line) })
}

function busySession(name: string, events: number, kind: 'tool_result' | 'turn_end' = 'tool_result'): number {
  const session = seedSession(temp.store, 'claude-code', name, clock)
  for (let i = 0; i < events; i += 1) seedEvent(temp.store, session, { kind: i === events - 1 ? kind : 'tool_result', at: clock, tool: { name: 'Bash', output: 'x' } })
  return session
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

test('a turn_end triggers a batch at once; a few fresh events without a boundary wait', () => {
  const quiet = busySession('quiet', 3)
  const turn = busySession('turn', 2, 'turn_end')
  scheduler().tick()
  expect(started).toEqual([turn])
  expect(started).not.toContain(quiet)
})

test('8 pending events trigger a batch without a boundary', () => {
  const seven = busySession('seven', 7)
  const eight = busySession('eight', 8)
  scheduler().tick()
  expect(started).toEqual([eight])
  expect(started).not.toContain(seven)
})

test('a session quiet for 60 s triggers a batch', () => {
  const session = busySession('quiet', 2)
  const s = scheduler()
  clock += 59_999
  s.tick()
  expect(started).toEqual([])
  clock += 1
  s.tick()
  expect(started).toEqual([session])
})

test('a session idle for 30 min with no ended_at is ended and gets its final batch', async () => {
  const session = busySession('opencode-quit', 1)
  const logs: string[] = []
  const s = scheduler(logs)
  clock += DEFAULT_SCHEDULE.sessionIdleMs
  s.tick()
  expect(temp.store.db.query('SELECT ended_at FROM sessions WHERE id = $id').get({ id: session })).toEqual({ ended_at: T0 })
  expect(logs).toContain(`observer ended idle sessions=${session}`)
  expect(started).toEqual([session])
  release.get(session)!()
  await s.whenIdle()
})

test('at most one call per session and two overall; a finished slot goes to the next due session', async () => {
  const sessions = ['a', 'b', 'c'].map((name) => busySession(name, 1, 'turn_end'))
  const s = scheduler()
  s.tick()
  s.tick()
  expect(started).toEqual([sessions[0]!, sessions[1]!])
  expect(s.inFlight().sort()).toEqual([sessions[0]!, sessions[1]!])

  seedEvent(temp.store, sessions[0]!, { kind: 'turn_end', at: clock })
  s.tick()
  expect(started).toHaveLength(2)

  release.get(sessions[1]!)!()
  await flush()
  expect(started).toEqual([sessions[0]!, sessions[1]!, sessions[2]!])
  release.get(sessions[0]!)!()
  release.get(sessions[2]!)!()
  await s.whenIdle()
  expect(s.inFlight()).toEqual([])
})

test('a crashed batch is logged by error name and frees its slot', async () => {
  busySession('a', 1, 'turn_end')
  const logs: string[] = []
  const s = createObserverScheduler({ db: temp.store.db, processSession: async () => { throw new RangeError('payload text here') }, now: () => clock, log: (line) => logs.push(line) })
  s.tick()
  await s.whenIdle()
  expect(logs).toEqual(['observer session=1 crashed error=RangeError'])
})

test('shouldObserve and SAM_SESSION_IDLE_MS parsing', () => {
  const base = { sessionId: 1, retryable: 1, hasBoundary: false, lastEventAt: T0, endedAt: null }
  expect(shouldObserve(base, T0, DEFAULT_SCHEDULE)).toBe(false)
  expect(shouldObserve({ ...base, endedAt: T0 }, T0, DEFAULT_SCHEDULE)).toBe(true)
  expect(parseIdleMs(undefined)).toBe(30 * 60_000)
  expect(parseIdleMs('1000')).toBe(1_000)
  expect(() => parseIdleMs('-5')).toThrow('SAM_SESSION_IDLE_MS')
})

/** A session whose tool results keep trickling in every 10 s, so it is never quiet and never reaches 8 pending. */
function trickle(name: string): number {
  return seedSession(temp.store, 'claude-code', name, clock)
}

function addResult(session: number): void {
  seedEvent(temp.store, session, { kind: 'tool_result', at: clock, tool: { name: 'Bash', output: 'x' } })
}

test('a pending event that waited maxWaitMs starts a mid-turn batch, reason waited', async () => {
  const session = trickle('long-turn')
  const reasons: string[] = []
  const s = createObserverScheduler({ db: temp.store.db, processSession, now: () => clock, onStart: (_, reason) => reasons.push(reason) })
  addResult(session)
  for (let waited = 10_000; waited < DEFAULT_SCHEDULE.maxWaitMs; waited += 10_000) {
    clock += 10_000
    if (waited % 30_000 === 0) addResult(session)
    s.tick()
  }
  expect(started).toEqual([])
  clock = T0 + DEFAULT_SCHEDULE.maxWaitMs
  s.tick()
  expect(started).toEqual([session])
  expect(reasons).toEqual(['waited'])
  release.get(session)!()
  await s.whenIdle()
})

test('waited starts are capped per turn and the cap resets after a turn_end batch', async () => {
  const session = trickle('capped')
  const reasons: string[] = []
  const s = createObserverScheduler({ db: temp.store.db, processSession, now: () => clock, onStart: (_, reason) => reasons.push(reason), config: { maxWaitMs: 1_000 } })
  const step = async (kind: 'tool_result' | 'turn_end' = 'tool_result'): Promise<void> => {
    seedEvent(temp.store, session, { kind, at: clock, tool: { name: 'Bash', output: 'x' } })
    clock += 1_000
    s.tick()
    release.get(session)?.()
    release.delete(session)
    await flush()
  }
  for (let i = 0; i < 5; i += 1) await step()
  expect(reasons).toEqual(['waited', 'waited'])
  await step('turn_end')
  expect(reasons).toEqual(['waited', 'waited', 'boundary'])
  await step()
  expect(reasons).toEqual(['waited', 'waited', 'boundary', 'waited'])
  await s.whenIdle()
})

test('an ended session that gets new events is live again; the legacy rule ran each one at once', () => {
  const session = busySession('resumed', 1)
  temp.store.db.run(`UPDATE sessions SET ended_at = ${clock - 1}`)
  const stats = { sessionId: session, retryable: 1, hasBoundary: false, lastEventAt: clock, endedAt: clock - 1, oldestPendingAt: clock }
  expect(dueReason(stats, clock, DEFAULT_SCHEDULE)).toBeNull()
  expect(dueReason(stats, clock, LEGACY_SCHEDULE)).toBe('ended')
  expect(dueReason({ ...stats, lastEventAt: clock - 1 }, clock, DEFAULT_SCHEDULE)).toBe('ended')
  scheduler().tick()
  expect(started).toEqual([])
})

test('due reasons keep their order, and SAM_OBSERVER_MAX_WAIT_MS parses like SAM_SESSION_IDLE_MS', () => {
  const base = { sessionId: 1, retryable: 8, hasBoundary: true, lastEventAt: T0, endedAt: null, oldestPendingAt: T0 }
  expect(dueReason(base, T0, DEFAULT_SCHEDULE)).toBe('boundary')
  expect(dueReason({ ...base, hasBoundary: false }, T0, DEFAULT_SCHEDULE)).toBe('count')
  expect(dueReason({ ...base, hasBoundary: false, retryable: 1 }, T0 + 60_000, DEFAULT_SCHEDULE)).toBe('quiet')
  expect(dueReason({ ...base, hasBoundary: false, retryable: 1, lastEventAt: T0 + 75_000 }, T0 + 75_000, DEFAULT_SCHEDULE)).toBe('waited')
  expect(dueReason({ ...base, hasBoundary: false, retryable: 1, lastEventAt: T0 + 75_000 }, T0 + 75_000, DEFAULT_SCHEDULE, 2)).toBeNull()
  expect(dueReason({ ...base, hasBoundary: false, retryable: 1, lastEventAt: T0 + 75_000, oldestPendingAt: null }, T0 + 75_000, DEFAULT_SCHEDULE)).toBeNull()
  expect(parseMaxWaitMs(undefined)).toBe(75_000)
  expect(parseMaxWaitMs('30000')).toBe(30_000)
  expect(() => parseMaxWaitMs('soon')).toThrow('SAM_OBSERVER_MAX_WAIT_MS')
})
