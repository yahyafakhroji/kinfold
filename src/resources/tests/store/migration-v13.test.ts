import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from '../../sqlite/types'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from '../../store/db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from '../../store/schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v13-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A v12 store with a session, a prompt, an observation saved from it and an injection for it. */
function v12Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const db = openTestDatabase(join(dataDir, 'memory.db'))
  db.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 12)) db.run(sql)
  db.run('PRAGMA user_version = 12')
  db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  db.run("INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES (1, 'claude-code', 's1', 'org/repo', '/w', 100, 900)")
  db.run("INSERT INTO prompts (session_id, prompt_number, text, occurred_at) VALUES (1, 1, 'prompt', 100)")
  db.run(`INSERT INTO observations (id, project_key, session_id, host, prompt_number, type, title, evidence, content_hash, occurred_at, created_at)
    VALUES (7, 'org/repo', 1, 'claude-code', 1, 'discovery', 'kept', 'tool-verified', 'oh', 100, 100)`)
  db.run(`INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at, prompt_number)
    VALUES (1, 'claude-code', 's1', 'org/repo', '[7]', 'prompt', 40, 105, 1)`)
  db.close()
}

const indexes = (db: Database): string[] =>
  db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name)
const plan = (db: Database, sql: string): string =>
  db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map((row) => row.detail).join('\n')

test('migration 12 -> 13 adds the late mark and the turn and metrics indexes, keeps the session index, and keeps every row', () => {
  const dataDir = join(root, 'data')
  v12Database(dataDir)
  const store = openStore(dataDir)
  try {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(13)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    const { db } = store
    expect(db.query('SELECT observation_ids AS ids, late FROM injections').all()).toEqual([{ ids: '[7]', late: 0 }])
    expect(db.query('SELECT id, title FROM observations').all()).toEqual([{ id: 7, title: 'kept' }])
    expect(indexes(db)).toContain('observations_by_session_prompt')
    expect(indexes(db)).toContain('prompts_by_time')
    expect(indexes(db)).toContain('injections_by_session_prompt')
    // The observer's read of what a session was given finds its rows by session_id, not by a scan.
    expect(plan(db, `SELECT i.observation_ids AS ids FROM injections i JOIN sessions s ON s.id = 1
     WHERE (i.session_id = s.id OR (i.session_id IS NULL AND i.host = s.host AND i.host_session_id = s.host_session_id)) AND i.late = 0`)).not.toMatch(/SCAN i\b/)
    expect(plan(db, 'SELECT id, title, type FROM observations WHERE session_id = 1 AND prompt_number = 1 ORDER BY id')).toContain('observations_by_session_prompt')
    expect(plan(db, 'SELECT s.host, count(*) AS n FROM prompts p JOIN sessions s ON s.id = p.session_id WHERE p.occurred_at >= 0 GROUP BY s.host')).toContain('prompts_by_time')
  } finally {
    store.db.close()
  }
})
