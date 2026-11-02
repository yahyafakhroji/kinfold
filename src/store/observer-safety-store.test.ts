import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type TempStore, T0, openTempStore, seedEvent, seedSession, stateCounts } from '../observer/test-support'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore, schemaVersionOf } from './db'
import { clearFailedSafety, getSafety, listSafety, recordSafety } from './observer-safety-store'
import { resetSafetyFailedEvents } from './observer-reset'
import { finishRun, markFailed, startRun } from './observer-store'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

let root: string
let temp: TempStore
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-safety-'))
  temp = openTempStore('sam-safety-store-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  temp.cleanup()
})

const CODEX = { provider: 'codex-cli', cliVersion: '0.50.0', binaryPath: '/usr/local/bin/codex' } as const

test('migration 9 -> 10 adds observer_safety and moves user_version forward to the latest', () => {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const v9 = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 9)) v9.run(sql)
  v9.run('PRAGMA user_version = 9')
  v9.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  v9.close()

  const store = openStore(dataDir)
  try {
    expect(LATEST_SCHEMA_VERSION).toBe(10)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(schemaVersionOf(store.db)).toBe(10)
    const columns = store.db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('observer_safety')").all().map((row) => row.name)
    expect(columns).toEqual(['provider', 'cli_version', 'binary_path', 'status', 'error_class', 'checked_at'])
    expect(store.db.query('SELECT key FROM projects').all()).toEqual([{ key: 'org/repo' }])
    expect(() => store.db.run("INSERT INTO observer_safety VALUES ('codex-cli', '1', '/x', 'maybe', NULL, 1)")).toThrow()
  } finally {
    store.db.close()
  }
  // Opening again does not re-run or roll back anything.
  const again = openStore(dataDir)
  try {
    expect(schemaVersionOf(again.db)).toBe(10)
  } finally {
    again.db.close()
  }
})

test('recordSafety round-trips and overwrites the row for the same key', () => {
  const db = temp.store.db
  expect(getSafety(db, CODEX)).toBeNull()
  recordSafety(db, CODEX, 'failed', 'tool_attempt', 100)
  expect(getSafety(db, CODEX)).toEqual({ ...CODEX, status: 'failed', errorClass: 'tool_attempt', checkedAt: 100 })
  recordSafety(db, CODEX, 'passed', null, 200)
  expect(getSafety(db, CODEX)).toEqual({ ...CODEX, status: 'passed', errorClass: null, checkedAt: 200 })
  expect(getSafety(db, { ...CODEX, cliVersion: '0.51.0' })).toBeNull()
  expect(listSafety(db)).toHaveLength(1)
})

test('clearFailedSafety deletes only failed rows of that provider', () => {
  const db = temp.store.db
  recordSafety(db, { ...CODEX, cliVersion: '0.49.0' }, 'passed', null, 1)
  recordSafety(db, CODEX, 'failed', 'tool_attempt', 1)
  recordSafety(db, { provider: 'opencode-cli', cliVersion: '2.1.4', binaryPath: '/bin/opencode' }, 'failed', 'safety_check_failed', 1)
  expect(clearFailedSafety(db, 'codex-cli')).toBe(1)
  expect(listSafety(db).map((row) => [row.provider, row.cliVersion, row.status])).toEqual([
    ['codex-cli', '0.49.0', 'passed'],
    ['opencode-cli', '2.1.4', 'failed'],
  ])
})

function failedSession(name: string, runs: { provider: string; error: string }[]): number {
  const session = seedSession(temp.store, 'claude-code', name)
  const id = seedEvent(temp.store, session, { kind: 'turn_end', at: T0, promptNumber: 1, assistantText: 'x' })
  runs.forEach((run, index) => {
    const runId = startRun(temp.store.db, { sessionId: session, host: 'claude-code', provider: run.provider, model: 'm', eventCount: 1, startedAt: T0 + index })
    finishRun(temp.store.db, runId, 'failed', run.error, T0 + index)
  })
  markFailed(temp.store.db, [id], T0)
  return session
}

test('resetSafetyFailedEvents sends back only events whose last run used that provider and failed a safety class', () => {
  const toolAttempt = failedSession('a', [{ provider: 'codex-cli', error: 'tool_attempt: a tool ran' }])
  const safety = failedSession('b', [{ provider: 'codex-cli', error: 'safety_check_failed: marker echoed' }])
  const timeout = failedSession('c', [{ provider: 'codex-cli', error: 'timeout: 120s' }])
  const other = failedSession('d', [{ provider: 'opencode-cli', error: 'tool_attempt: a tool ran' }])
  const later = failedSession('e', [{ provider: 'codex-cli', error: 'tool_attempt: a tool ran' }, { provider: 'codex-cli', error: 'bad_output: not json' }])

  expect(resetSafetyFailedEvents(temp.store.db, 'codex-cli')).toBe(2)
  expect(stateCounts(temp.store, toolAttempt)).toEqual({ pending: 1 })
  expect(stateCounts(temp.store, safety)).toEqual({ pending: 1 })
  for (const session of [timeout, other, later]) expect(stateCounts(temp.store, session)).toEqual({ failed: 1 })
  expect(temp.store.db.query('SELECT observer_attempts AS n FROM events WHERE session_id = ?').get(toolAttempt)).toEqual({ n: 0 })
})

test('a passed row retires the same provider failed rows, and no other provider rows', () => {
  const db = temp.store.db
  const OPEN = { provider: 'opencode-cli', cliVersion: '2.1.4', binaryPath: '/bin/opencode' } as const
  recordSafety(db, { ...CODEX, cliVersion: '1.0' }, 'failed', 'tool_attempt', 1)
  recordSafety(db, OPEN, 'failed', 'safety_check_failed', 1)
  recordSafety(db, { ...CODEX, cliVersion: '2.0' }, 'passed', null, 2)
  expect(listSafety(db).map((row) => [row.provider, row.cliVersion, row.status])).toEqual([
    ['codex-cli', '2.0', 'passed'],
    ['opencode-cli', '2.1.4', 'failed'],
  ])
  recordSafety(db, { ...CODEX, cliVersion: '3.0' }, 'failed', 'tool_attempt', 3)
  expect(listSafety(db).filter((row) => row.provider === 'codex-cli')).toHaveLength(2)
})
