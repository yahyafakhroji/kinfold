import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createTraceBuffer } from '../debug/trace'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { recordInjection } from '../store/context-store'
import { upsertProject, upsertSession } from '../store/writes'
import { debugWatchRoute, observerTrace, turnTrace } from './debug-trace'

let temp: TempStore
let session: number
const KEY = '/work/repo'
beforeEach(() => {
  temp = openTempStore('kinfold-debug-trace-')
  upsertProject(temp.store.db, { key: KEY, kind: 'path', displayName: 'repo' }, T0)
  session = upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'cc-1', projectKey: KEY, cwd: KEY, occurredAt: T0 })
})
afterEach(() => temp.cleanup())

const USAGE = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheCreationTokens: 0, toolCalls: 2, durationMs: 4_000 }

test('a turn event carries the usage and the tokens Kinfold added to that prompt', () => {
  recordInjection(temp.store.db, { sessionId: session, host: 'claude-code', hostSessionId: 'cc-1', projectKey: KEY, observationIds: [1], channel: 'prompt', tokens: 42, occurredAt: T0, promptNumber: 3 })
  recordInjection(temp.store.db, { sessionId: session, host: 'claude-code', hostSessionId: 'cc-1', projectKey: KEY, observationIds: [2], channel: 'prompt', tokens: 99, occurredAt: T0, promptNumber: 2 })
  const turn = { sessionId: session, promptNumber: 3, host: 'claude-code', projectKey: KEY, transcriptPath: '/x', occurredAt: T0 + 5 }
  expect(turnTrace(temp.store.db, turn, USAGE)).toEqual({
    kind: 'turn', at: T0 + 5, host: 'claude-code', project: 'repo', projectKey: KEY, hostSessionId: 'cc-1', promptNumber: 3, usage: USAGE, kinfoldTokens: 42,
  })
  expect(turnTrace(temp.store.db, { ...turn, sessionId: 9_999 }, USAGE)).toBeNull()
})

test('an observer outcome becomes an event; an idle look does not', () => {
  expect(observerTrace(temp.store.db, session, { status: 'skipped', events: 3 }, T0)).toMatchObject({ kind: 'observer', status: 'skipped', events: 3, written: 0, host: 'claude-code', project: 'repo' })
  expect(observerTrace(temp.store.db, session, { status: 'idle' }, T0)).toBeNull()
})

test('GET /watch/debug answers from the buffer, validates its query and starts from now without a cursor', () => {
  const trace = createTraceBuffer()
  trace.push({ kind: 'start', at: T0, host: 'claude-code', project: 'repo', projectKey: KEY, hostSessionId: 'cc-1', rows: [], tokens: 0 })
  const ask = (query: string, method = 'GET') => debugWatchRoute(trace, method, new URL(`http://127.0.0.1/watch/debug${query}`), T0)
  expect(ask('')).toMatchObject({ status: 200, body: { cursor: 1, events: [] } })
  expect(ask('?after=0&host=claude-code&project=repo').body).toMatchObject({ cursor: 1, events: [{ seq: 1, kind: 'start' }] })
  expect(ask('?after=x').status).toBe(400)
  expect(ask('?host=NOT%20A%20HOST').status).toBe(400)
  expect(ask('', 'POST').status).toBe(405)
  expect(trace.watching(T0)).toBe(true)
})
