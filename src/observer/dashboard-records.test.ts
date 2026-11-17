import { afterEach, beforeEach, expect, test } from 'bun:test'
import { listActivity } from '../store/activity-store'
import { processSessionBatch } from './process'
import { type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession } from './test-support'
import { ObserverError, type ObserverPrompt } from './types'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-observer-records-')
})
afterEach(() => temp.cleanup())

function seedTurn(sessionId: number): void {
  seedEvent(temp.store, sessionId, { kind: 'user_prompt', at: T0, promptNumber: 1, promptText: 'run the tests' })
  seedEvent(temp.store, sessionId, { kind: 'tool_result', at: T0 + 10, promptNumber: 1, tool: { name: 'Bash', output: '98 pass', exitCode: 0 } })
  seedEvent(temp.store, sessionId, { kind: 'turn_end', at: T0 + 30, promptNumber: 1, assistantText: 'all green' })
}

const reply = (prompt: ObserverPrompt): string => JSON.stringify({
  observations: [
    { type: 'discovery', title: 'Tests pass', narrative: 'n', facts: [], files: [], evidence: { strength: 'tool-verified', sourceEventIds: [prompt.eventIds[1]] } },
    { type: 'decision', title: 'Run tests first', narrative: '', facts: [], files: [], evidence: { strength: 'user-stated', sourceEventIds: [prompt.eventIds[0]] } },
  ],
  summary: { request: 'run the tests', learned: 'they pass', completed: 'ran them', nextSteps: 'none' },
})

const run = (runner: ReturnType<typeof fakeRunner>, sessionId: number) =>
  processSessionBatch({ db: temp.store.db, runnerFor: () => runner, now: () => T0 + 120_000, log: () => {} }, sessionId)

test('each saved memory names the run that made it, and the run shows up as activity', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  await run(fakeRunner([reply]), session)
  const runId = (temp.store.db.query('SELECT id FROM observer_runs').get() as { id: number }).id
  expect(temp.store.db.query('SELECT observer_run_id AS run FROM observations ORDER BY id').all()).toEqual([{ run: runId }, { run: runId }])
  const rows = listActivity(temp.store.db, { kinds: null, limit: 10, offset: 0 }).rows
  expect(rows.map((row) => [row.kind, row.count, row.sessionId, row.host])).toEqual([['summary', 1, session, 'claude-code'], ['save', 2, session, 'claude-code']])
})

test('a failed run records its error class, never the detail', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  await run(fakeRunner([new ObserverError('timeout', 'after 120 s')]), session)
  const rows = listActivity(temp.store.db, { kinds: null, limit: 10, offset: 0 }).rows
  expect(rows.map((row) => [row.kind, row.detail, row.host])).toEqual([['observer-failed', 'timeout', 'claude-code']])
})
