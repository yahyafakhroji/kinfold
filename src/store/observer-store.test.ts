import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TempStore, T0, openTempStore, seedEvent, seedSession, stateCounts } from '../observer/test-support'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore, schemaVersionOf } from './db'
import { MAX_OBSERVER_ATTEMPTS, QUEUE_STATS_SQL, endIdleSessions, markProcessing, queueStats, recoverInterrupted, startRun, upsertSummary } from './observer-store'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('migrations from an existing v1 database keep its rows and add the observer columns', () => {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const v1 = openTestDatabase(join(dataDir, 'memory.db'))
  v1.run('PRAGMA journal_mode = WAL')
  v1.run(MIGRATIONS[0]!)
  v1.run('PRAGMA user_version = 1')
  v1.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  v1.run("INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES ('claude-code', 's', 'org/repo', '/w', 1, 2)")
  v1.run("INSERT INTO events (event_id, session_id, kind, content_hash, occurred_at, ingested_at) VALUES ('E1', 1, 'turn_end', 'h', 2, 3)")
  v1.close()

  const store = openStore(dataDir)
  try {
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(schemaVersionOf(store.db)).toBe(LATEST_SCHEMA_VERSION)
    expect(store.db.query('SELECT event_id, observer_state, observer_attempts, observer_retry_at FROM events').all()).toEqual([
      { event_id: 'E1', observer_state: 'pending', observer_attempts: 0, observer_retry_at: null },
    ])
    expect(store.db.query('SELECT host FROM sessions').all()).toEqual([{ host: 'claude-code' }])
    const columns = store.db.query("SELECT name FROM pragma_table_info('observer_runs')").all().map((row) => (row as { name: string }).name)
    expect(columns).toEqual(['id', 'session_id', 'host', 'provider', 'model', 'status', 'error', 'event_count', 'started_at', 'finished_at'])
  } finally {
    store.db.close()
  }
})

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-observer-store-')
})
afterEach(() => temp.cleanup())

test('the summary upsert keeps one row per prompt and bumps its revision', () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  const row = { sessionId: session, promptNumber: 1, request: 'a', learned: 'b', completed: 'c', nextSteps: 'd', occurredAt: 10, updatedAt: 10 }
  upsertSummary(temp.store.db, row)
  upsertSummary(temp.store.db, { ...row, learned: 'b2', occurredAt: 20, updatedAt: 20 })
  upsertSummary(temp.store.db, { ...row, learned: 'b3', occurredAt: 15, updatedAt: 30 })
  expect(temp.store.db.query('SELECT prompt_number, learned, revision, occurred_at FROM summaries').all()).toEqual([
    { prompt_number: 1, learned: 'b3', revision: 3, occurred_at: 20 },
  ])
})

test('after a crash, claimed events go back to pending and the open run is closed as interrupted', () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  const id = seedEvent(temp.store, session, { kind: 'turn_end', at: T0 })
  markProcessing(temp.store.db, [id])
  startRun(temp.store.db, { sessionId: session, host: 'claude-code', provider: 'claude-cli', model: 'haiku', eventCount: 1, startedAt: T0 })
  expect(recoverInterrupted(temp.store.db, T0 + 5)).toEqual({ events: 1, runs: 1 })
  expect(stateCounts(temp.store, session)).toEqual({ pending: 1 })
  expect(temp.store.db.query('SELECT status, error, finished_at FROM observer_runs').get()).toEqual({
    status: 'failed', error: 'interrupted: daemon stopped mid-run', finished_at: T0 + 5,
  })
})

test('an idle session with no ended_at gets ended_at at its last event; ended or recent ones are left alone', () => {
  const idle = seedSession(temp.store, 'opencode', 'idle', T0)
  const recent = seedSession(temp.store, 'opencode', 'recent', T0 + 1_000)
  const ended = seedSession(temp.store, 'claude-code', 'ended', T0)
  temp.store.db.run(`UPDATE sessions SET ended_at = ${T0 - 1} WHERE id = ${ended}`)
  expect(endIdleSessions(temp.store.db, T0 + 500)).toEqual([idle])
  const endedAt = (id: number) => (temp.store.db.query(`SELECT ended_at FROM sessions WHERE id = ${id}`).get() as { ended_at: number | null }).ended_at
  expect([endedAt(idle), endedAt(recent), endedAt(ended)]).toEqual([T0, null, T0 - 1])
})

test('queue stats count pending and due failed events per session, oldest first, and skip the rest', () => {
  const pending = seedSession(temp.store, 'claude-code', 'pending', T0)
  const due = seedSession(temp.store, 'claude-code', 'due', T0)
  const waiting = seedSession(temp.store, 'claude-code', 'waiting', T0)
  const exhausted = seedSession(temp.store, 'claude-code', 'exhausted', T0)
  const done = seedSession(temp.store, 'claude-code', 'done', T0)
  seedEvent(temp.store, pending, { kind: 'user_prompt', at: T0 + 20 })
  seedEvent(temp.store, pending, { kind: 'turn_end', at: T0 + 21 })
  const set = (id: string, sql: string) => temp.store.db.run(`UPDATE events SET ${sql} WHERE event_id = '${id}'`)
  set(seedEvent(temp.store, due, { kind: 'user_prompt', at: T0 + 10 }), `observer_state = 'failed', observer_attempts = 1, observer_retry_at = ${T0 + 50}`)
  set(seedEvent(temp.store, waiting, { kind: 'user_prompt', at: T0 }), `observer_state = 'failed', observer_attempts = 1, observer_retry_at = ${T0 + 500}`)
  set(seedEvent(temp.store, exhausted, { kind: 'user_prompt', at: T0 }), `observer_state = 'failed', observer_attempts = ${MAX_OBSERVER_ATTEMPTS}, observer_retry_at = ${T0}`)
  set(seedEvent(temp.store, done, { kind: 'turn_end', at: T0 }), "observer_state = 'done'")
  const mixed = seedSession(temp.store, 'claude-code', 'mixed', T0)
  seedEvent(temp.store, mixed, { kind: 'user_prompt', at: T0 + 40 })
  set(seedEvent(temp.store, mixed, { kind: 'turn_end', at: T0 + 30 }), "observer_state = 'failed', observer_attempts = 1, observer_retry_at = NULL")
  const stats = queueStats(temp.store.db, T0 + 100)
  expect(stats.map(({ sessionId, retryable, hasBoundary }) => ({ sessionId, retryable, hasBoundary }))).toEqual([
    { sessionId: due, retryable: 1, hasBoundary: false },
    { sessionId: pending, retryable: 2, hasBoundary: true },
    { sessionId: mixed, retryable: 2, hasBoundary: true },
  ])
})

test('queue stats read pending and failed events through their partial indexes, never every event of every session', () => {
  const plan = (temp.store.db.query(`EXPLAIN QUERY PLAN ${QUEUE_STATS_SQL}`).all({ now: T0, maxAttempts: MAX_OBSERVER_ATTEMPTS }) as { detail: string }[])
    .map((row) => row.detail)
  expect(plan.some((step) => step.includes('events_pending'))).toBe(true)
  expect(plan.some((step) => step.includes('events_failed'))).toBe(true)
  expect(plan.some((step) => step.includes('events_by_session'))).toBe(false)
})

const summaryRow = (sessionId: number) => ({ sessionId, promptNumber: 2, request: 'fix the parser', learned: 'quotes dropped', completed: 'patched', nextSteps: 'add a test', occurredAt: 10, updatedAt: 10 })
const storedSummaries = () => temp.store.db.query('SELECT prompt_number, request, learned, completed, next_steps, revision, updated_at FROM summaries').all()

test('summary upsert, new: the first write stores revision 1', () => {
  upsertSummary(temp.store.db, summaryRow(seedSession(temp.store, 'claude-code', 's1')))
  expect(storedSummaries()).toEqual([
    { prompt_number: 2, request: 'fix the parser', learned: 'quotes dropped', completed: 'patched', next_steps: 'add a test', revision: 1, updated_at: 10 },
  ])
})

test('summary upsert, re-run: non-empty fields replace, revision and updated_at move', () => {
  const row = summaryRow(seedSession(temp.store, 'claude-code', 's1'))
  upsertSummary(temp.store.db, row)
  upsertSummary(temp.store.db, { ...row, completed: 'patched and tested', updatedAt: 25 })
  expect(storedSummaries()).toEqual([
    { prompt_number: 2, request: 'fix the parser', learned: 'quotes dropped', completed: 'patched and tested', next_steps: 'add a test', revision: 2, updated_at: 25 },
  ])
})

test('summary upsert, empty field: an empty or blank field never overwrites a stored one', () => {
  const row = summaryRow(seedSession(temp.store, 'claude-code', 's1'))
  upsertSummary(temp.store.db, row)
  upsertSummary(temp.store.db, { ...row, request: '', learned: '   ', nextSteps: 'ship it', updatedAt: 30 })
  expect(storedSummaries()).toEqual([
    { prompt_number: 2, request: 'fix the parser', learned: 'quotes dropped', completed: 'patched', next_steps: 'ship it', revision: 2, updated_at: 30 },
  ])
})
