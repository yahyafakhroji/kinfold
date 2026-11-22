import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '../../sqlite/types'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from '../../store/db'
import { MIGRATIONS } from '../../store/schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v18-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A v17 store: a local session, a session a device captured on a hub, two observations, and injections that recalled them. */
function v17Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const db = openTestDatabase(join(dataDir, 'memory.db'))
  db.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 17)) db.run(sql)
  db.run('PRAGMA user_version = 17')
  db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1), ('dev-abc123:/w/x', 'path', 'x', 1)")
  db.run(`INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES
    (1, 'claude-code', 's1', 'org/repo', '/w', 100, 900), (2, 'codex', 's2', 'dev-abc123:/w/x', '/w/x', 200, 300)`)
  db.run(`INSERT INTO observations (id, project_key, session_id, host, prompt_number, type, title, evidence, content_hash, occurred_at, created_at) VALUES
    (7, 'org/repo', 1, 'claude-code', 1, 'discovery', 'seven', 'tool-verified', 'h7', 100, 100),
    (8, 'org/repo', 1, 'claude-code', 1, 'discovery', 'eight', 'tool-verified', 'h8', 100, 100),
    (9, 'org/repo', 1, 'claude-code', 1, 'discovery', 'nine', 'tool-verified', 'h9', 100, 100)`)
  db.run(`INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at, prompt_number, late) VALUES
    (1, 'claude-code', 's1', 'org/repo', '[7,8]', 'session_start', 40, 105, NULL, 0),
    (1, 'claude-code', 's1', 'org/repo', '[7]', 'prompt', 10, 106, 1, 0),
    (1, 'claude-code', 's1', 'org/repo', '[8]', 'prompt', 10, 107, 2, 1)`)
  db.close()
}

const columns = (db: Database, table: string): string[] => db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((row) => row.name)
const plan = (db: Database, sql: string): string => db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join('\n')

test('migration 17 -> 18 records devices, recall counts, run links and activity, and keeps every row', () => {
  const dataDir = join(root, 'data')
  v17Database(dataDir)
  const before = Date.now()
  const store = openStore(dataDir)
  try {
    const { db } = store
    expect(store.schemaVersion).toBeGreaterThanOrEqual(18)
    // A device-scoped key names its device; a shared remote key cannot say which machine captured it.
    expect(db.query('SELECT id, device FROM sessions ORDER BY id').all()).toEqual([{ id: 1, device: null }, { id: 2, device: 'dev-abc123' }])
    // Counted from what was delivered: the late row was probably never shown.
    expect(db.query('SELECT id, recall_count AS n FROM observations ORDER BY id').all()).toEqual([{ id: 7, n: 2 }, { id: 8, n: 1 }, { id: 9, n: 0 }])
    expect(columns(db, 'observations')).toContain('observer_run_id')
    expect(db.query('SELECT count(*) AS n FROM observations WHERE observer_run_id IS NOT NULL').get()).toEqual({ n: 0 })
    expect(columns(db, 'activity')).toEqual(['id', 'at', 'kind', 'host', 'project_key', 'session_id', 'device', 'count', 'detail'])
    const since = db.query<{ value: number }, []>("SELECT value FROM data_settings WHERE key = 'records.since'").get()?.value ?? 0
    expect(since).toBeGreaterThanOrEqual(before)
    expect(plan(db, 'SELECT id FROM observations ORDER BY recall_count DESC, id DESC LIMIT 50')).toContain('observations_by_recalls')
    expect(plan(db, 'SELECT id FROM sessions ORDER BY started_at DESC, id DESC LIMIT 50')).toContain('sessions_by_started')
    expect(plan(db, 'SELECT id FROM activity ORDER BY at DESC, id DESC LIMIT 50')).toContain('activity_by_time')
    expect(plan(db, "SELECT id FROM activity WHERE kind = 'recall' ORDER BY at DESC, id DESC LIMIT 50")).toContain('activity_by_kind')
  } finally {
    store.db.close()
  }
})

test('a new store starts at v18 with the new columns empty', () => {
  const store = openStore(join(root, 'fresh'))
  try {
    expect(columns(store.db, 'sessions')).toContain('device')
    expect(columns(store.db, 'observations')).toContain('recall_count')
    expect(store.db.query('SELECT count(*) AS n FROM activity').get()).toEqual({ n: 0 })
  } finally {
    store.db.close()
  }
})
