import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RULES_VERSION } from '../redaction/rules'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from './db'
import { insertEvent } from './writes'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v4-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function v3Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const v3 = openTestDatabase(join(dataDir, 'memory.db'))
  v3.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 3)) v3.run(sql)
  v3.run('PRAGMA user_version = 3')
  v3.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  v3.run("INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES ('claude-code', 's', 'org/repo', '/w', 1, 2)")
  v3.run("INSERT INTO prompts (session_id, prompt_number, text, occurred_at) VALUES (1, 1, 'old prompt', 1)")
  v3.run("INSERT INTO events (event_id, session_id, kind, payload, content_hash, occurred_at, ingested_at) VALUES ('E1', 1, 'tool_result', '{}', 'h', 1, 1)")
  v3.run(`INSERT INTO observations (project_key, session_id, host, type, title, evidence, content_hash, occurred_at, created_at)
          VALUES ('org/repo', 1, 'claude-code', 'discovery', 'old fact', 'tool-verified', 'h', 1, 1)`)
  v3.run("INSERT INTO summaries (session_id, prompt_number, next_steps, occurred_at, updated_at) VALUES (1, 1, 'old next', 1, 1)")
  v3.close()
}

test('migration 3 -> 4 keeps every v3 row and records rules version 1 for it', () => {
  const dataDir = join(root, 'data')
  v3Database(dataDir)
  const store = openStore(dataDir)
  try {
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    for (const table of ['events', 'prompts', 'observations', 'summaries']) {
      expect(store.db.query(`SELECT count(*) AS n, min(rules_version) AS r, max(scanned_version) AS s FROM ${table}`).get()).toEqual({ n: 1, r: 1, s: 1 })
    }
    expect(store.db.query('SELECT title FROM observations').get()).toEqual({ title: 'old fact' })
    expect(store.db.query("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'fact'").all()).toEqual([{ rowid: 1 }])
    expect(store.db.query('SELECT key, value FROM data_settings ORDER BY key').all()).toEqual([
      { key: 'retention.events', value: 30 },
      { key: 'retention.observations', value: null },
      { key: 'retention.prompts', value: null },
      { key: 'retention.summaries', value: null },
      { key: 'size.warn_bytes', value: 268_435_456 },
    ])
    expect(store.db.query('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 })
  } finally {
    store.db.close()
  }
})

test('rows written after v4 carry the current rules version', () => {
  const store = openStore(join(root, 'fresh'))
  try {
    store.db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('p', 'path', 'p', 1)")
    store.db.run("INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES ('h', 's', 'p', '/p', 1, 1)")
    insertEvent(store.db, { eventId: 'E2', sessionId: 1, promptNumber: null, kind: 'turn_end', toolName: null, payload: '{}', withheld: null, redactions: '[]', contentHash: 'x', occurredAt: 1, ingestedAt: 1 })
    expect(store.db.query('SELECT rules_version AS r, scanned_version AS s FROM events').get()).toEqual({ r: RULES_VERSION, s: RULES_VERSION })
  } finally {
    store.db.close()
  }
})
