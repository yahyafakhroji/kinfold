import { afterEach, beforeEach, expect, test } from 'bun:test'
import { NO_CREDENTIALS } from '../secrets/credentials'
import { RETRY_BASE_MS } from '../store/observer-store'
import { insertPrompt } from '../store/writes'
import { processSessionBatch } from './process'
import { createRunner } from './runners'
import type { SpawnFn } from './runners/claude-cli'
import type { FetchFn } from './runners/openrouter'
import { type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession, stateCounts } from './test-support'
import { ObserverError, type ObserverPrompt, type ObserverRunner } from './types'

let temp: TempStore
let logs: string[]
let clock: number
beforeEach(() => {
  temp = openTempStore('sam-process-')
  logs = []
  clock = T0 + 120_000
})
afterEach(() => temp.cleanup())

const SECRETISH = 'PAYLOAD-TEXT-THAT-MUST-NOT-BE-LOGGED'

function seedTurn(sessionId: number, at: number = T0, promptNumber = 1): string[] {
  return [
    seedEvent(temp.store, sessionId, { kind: 'user_prompt', at, promptNumber, promptText: `run the tests ${SECRETISH}` }),
    seedEvent(temp.store, sessionId, { kind: 'tool_result', at: at + 10, promptNumber, tool: { name: 'Bash', output: `98 pass ${SECRETISH}`, exitCode: 0 } }),
    seedEvent(temp.store, sessionId, { kind: 'tool_result', at: at + 20, promptNumber, tool: { name: 'Bash', output: '', exitCode: 0 } }),
    seedEvent(temp.store, sessionId, { kind: 'turn_end', at: at + 30, promptNumber, assistantText: 'all green' }),
  ]
}

function citingReply(title = 'Adapter tests pass'): (prompt: ObserverPrompt) => string {
  return (prompt) => JSON.stringify({
    observations: [
      { type: 'discovery', title, narrative: 'n', facts: ['98 pass'], files: [], evidence: { strength: 'tool-verified', sourceEventIds: [prompt.eventIds[1]] } },
      { type: 'discovery', title: `${title}: empty grep`, narrative: '', facts: [], files: [], evidence: { strength: 'tool-verified', sourceEventIds: [prompt.eventIds[2]] } },
      { type: 'decision', title: 'User wants tests run', narrative: '', facts: [], files: [], evidence: { strength: 'user-stated', sourceEventIds: [prompt.eventIds[0], 'NOT-IN-BATCH'] } },
    ],
    summary: { request: 'run the tests', learned: 'they pass', completed: 'ran them', nextSteps: 'none' },
  })
}

function process(runner: ObserverRunner | (() => ObserverRunner), sessionId: number) {
  const runnerFor = typeof runner === 'function' ? runner : () => runner
  return processSessionBatch({ db: temp.store.db, runnerFor, now: () => clock, log: (line) => logs.push(line) }, sessionId)
}

const runs = () => temp.store.db.query('SELECT * FROM observer_runs ORDER BY id').all() as Record<string, unknown>[]
const observations = () => temp.store.db.query('SELECT * FROM observations ORDER BY id').all() as Record<string, unknown>[]
const summaries = () => temp.store.db.query('SELECT * FROM summaries').all() as Record<string, unknown>[]

test('a successful batch stores observations with the daemon verdict, a summary, and marks events done', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  const ids = seedTurn(session)
  const outcome = await process(fakeRunner([citingReply()], 'claude-haiku-5-5'), session)

  expect(outcome).toMatchObject({ status: 'succeeded', events: 4, observations: 3, inserted: 3, downgraded: 1, summary: true })
  expect(observations().map((row) => [row.title, row.evidence])).toEqual([
    ['Adapter tests pass', 'tool-verified'],
    ['Adapter tests pass: empty grep', 'interpretation'],
    ['User wants tests run', 'user-stated'],
  ])
  expect(observations()[0]).toMatchObject({ occurred_at: T0 + 10, observer_model: 'claude-haiku-5-5', host: 'claude-code', project_key: 'org/repo', prompt_number: 1 })
  expect(JSON.parse(observations()[2]!.source_event_ids as string)).toEqual([ids[0]])
  expect(summaries()).toEqual([expect.objectContaining({ prompt_number: 1, request: 'run the tests', revision: 1, occurred_at: T0 + 30 })])
  expect(stateCounts(temp.store, session)).toEqual({ done: 4 })
  expect(runs()).toEqual([expect.objectContaining({ status: 'succeeded', provider: 'claude-cli', model: 'claude-haiku-5-5', event_count: 4, error: null })])
})

test('a second batch for the same prompt bumps the summary revision and dedupes repeated observations', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  await process(fakeRunner([citingReply()]), session)
  seedTurn(session, T0 + 1_000)
  const second = await process(fakeRunner([citingReply()]), session)

  expect(second).toMatchObject({ status: 'succeeded', observations: 3, inserted: 0 })
  expect(observations()).toHaveLength(3)
  expect(summaries()).toEqual([expect.objectContaining({ prompt_number: 1, revision: 2, occurred_at: T0 + 1_030 })])
})

test('a missing credential records the failure, leaves events retryable and calls no provider at all', async () => {
  const session = seedSession(temp.store, 'opencode', 'o1')
  seedTurn(session)
  const calls: string[] = []
  const fetch: FetchFn = async () => {
    calls.push('fetch')
    return new Response('{}')
  }
  const spawn: SpawnFn = async () => {
    calls.push('spawn')
    return { exitCode: 0, stdout: '', timedOut: false }
  }
  const outcome = await processSessionBatch(
    { db: temp.store.db, runnerFor: (settings) => createRunner(settings, { dataDir: temp.dataDir, credentials: NO_CREDENTIALS, fetch, spawn }), now: () => clock },
    session,
  )

  expect(outcome).toMatchObject({ status: 'failed', errorClass: 'credential_missing' })
  expect(calls).toEqual([])
  expect(runs()).toEqual([expect.objectContaining({ status: 'failed', provider: 'openrouter', model: 'openrouter/auto', error: 'credential_missing: no keychain entry for openrouter' })])
  expect(stateCounts(temp.store, session)).toEqual({ failed: 4 })
  expect(observations()).toEqual([])
})

test('failed events are retried with backoff and stop, still visible, after 3 attempts', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  const runner = fakeRunner([new ObserverError('exit_nonzero', 'claude exited 1')])
  const attempts = () => temp.store.db.query('SELECT DISTINCT observer_attempts AS n FROM events').all()

  expect(await process(runner, session)).toMatchObject({ status: 'failed', errorClass: 'exit_nonzero' })
  expect(attempts()).toEqual([{ n: 1 }])
  expect(await process(runner, session)).toEqual({ status: 'idle' })
  clock += RETRY_BASE_MS
  expect(await process(runner, session)).toMatchObject({ status: 'failed' })
  expect(attempts()).toEqual([{ n: 2 }])
  clock += RETRY_BASE_MS
  expect(await process(runner, session)).toEqual({ status: 'idle' })
  clock += RETRY_BASE_MS
  expect(await process(runner, session)).toMatchObject({ status: 'failed' })
  clock += 24 * 3_600_000
  expect(await process(runner, session)).toEqual({ status: 'idle' })

  expect(attempts()).toEqual([{ n: 3 }])
  expect(stateCounts(temp.store, session)).toEqual({ failed: 4 })
  expect(runner.prompts).toHaveLength(3)
  expect(runs().map((row) => row.status)).toEqual(['failed', 'failed', 'failed'])
})

test('a reply that is not valid JSON is a recorded bad_output failure', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  expect(await process(fakeRunner(['I think the tests passed!']), session)).toMatchObject({ status: 'failed', errorClass: 'bad_output' })
  expect(runs()[0]!.error).toBe('bad_output: reply is not valid JSON')
})

test('an unknown provider in settings fails the run as config_invalid without calling any runner', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  temp.store.db.run("INSERT INTO observer_settings (host, provider, model, enabled, updated_at) VALUES ('claude-code', 'mystery', 'm', 1, 1)")
  const runner = fakeRunner(['{}'])
  expect(await process(runner, session)).toMatchObject({ status: 'failed', errorClass: 'config_invalid' })
  expect(runner.prompts).toEqual([])
  expect(runs()[0]).toMatchObject({ provider: 'unresolved', model: 'unresolved' })
})

test('a disabled host leaves events pending and records no run', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  temp.store.db.run("INSERT INTO observer_settings (host, provider, model, enabled, updated_at) VALUES ('claude-code', 'claude-cli', 'haiku', 0, 1)")
  expect(await process(fakeRunner(['{}']), session)).toEqual({ status: 'disabled' })
  expect(stateCounts(temp.store, session)).toEqual({ pending: 4 })
  expect(runs()).toEqual([])
})

test('logs carry ids, counts, provider and error class, never payload text or model output', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedTurn(session)
  await process(fakeRunner([citingReply(`TITLE ${SECRETISH}`)]), session)
  seedTurn(session, T0 + 5_000, 2)
  await process(fakeRunner([`garbage ${SECRETISH}`]), session)

  expect(logs).toHaveLength(2)
  expect(logs[0]).toMatch(/^observer session=1 host=claude-code provider=claude-cli model=haiku run=1 events=4 status=succeeded .* ms=\d+$/)
  expect(logs[1]).toContain('status=failed error=bad_output')
  expect(logs.join('\n')).not.toContain(SECRETISH)
  expect(JSON.stringify(runs())).not.toContain(SECRETISH)
})

test('a batch with only session_start / session_end is marked done without a model call', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  seedEvent(temp.store, session, { kind: 'session_start', at: T0 })
  seedEvent(temp.store, session, { kind: 'session_end', at: T0 + 5 })
  const runner = fakeRunner(['{}'])
  expect(await process(runner, session)).toEqual({ status: 'skipped', events: 2 })
  expect(runner.prompts).toEqual([])
  expect(runs()).toEqual([])
  expect(stateCounts(temp.store, session)).toEqual({ done: 2 })
})

test('a repeated prompt gets the repeat hint, may return summary null, and shares the first summary (P1-I)', async () => {
  const first = seedSession(temp.store, 'claude-code', 'r1')
  const second = seedSession(temp.store, 'opencode', 'r2')
  for (const sessionId of [first, second]) {
    insertPrompt(temp.store.db, { sessionId, promptNumber: 1, text: `run the tests ${SECRETISH}`, occurredAt: T0 })
    seedTurn(sessionId)
  }
  const runner = fakeRunner([citingReply(), (prompt) => JSON.stringify({ observations: [], summary: null, echo: prompt.eventIds.length })])
  await process(runner, first)
  expect(runner.prompts[0]!.user).not.toContain('repeat an earlier prompt')
  const outcome = await process(runner, second)
  expect(runner.prompts[1]!.user).toContain('Prompt number(s) 1 repeat an earlier prompt of this project word for word')
  expect(outcome).toMatchObject({ status: 'succeeded', summary: true, summaryShared: true })
  expect(summaries().map((row) => [row.request, row.repeat_count])).toEqual([['run the tests', 2]])
  expect(logs.join('\n')).not.toContain(SECRETISH)
})
