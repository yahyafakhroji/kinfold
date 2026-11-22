import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v3-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('migration 2 -> 3 keeps v2 rows: packs gain empty ids, injections keep theirs with start mapped to session_start', () => {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const v2 = openTestDatabase(join(dataDir, 'memory.db'))
  v2.run('PRAGMA journal_mode = WAL')
  v2.run(MIGRATIONS[0]!)
  v2.run(MIGRATIONS[1]!)
  v2.run('PRAGMA user_version = 2')
  v2.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  v2.run("INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES ('claude-code', 's', 'org/repo', '/w', 1, 2)")
  v2.run("INSERT INTO context_packs (project_key, host_profile, body, token_count, built_from_max_id, built_at) VALUES ('org/repo', 'claude-code', 'old body', 2, 0, 5)")
  v2.run("INSERT INTO injections (session_id, host, observation_ids, channel, tokens, occurred_at) VALUES (1, 'claude-code', '[4]', 'start', 9, 7)")
  v2.run("INSERT INTO injections (session_id, host, observation_ids, channel, tokens, occurred_at) VALUES (1, 'claude-code', '[]', 'mcp', 1, 8)")
  v2.close()

  const store = openStore(dataDir)
  try {
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(store.db.query('SELECT body, observation_ids FROM context_packs').all()).toEqual([{ body: 'old body', observation_ids: '[]' }])
    expect(store.db.query('SELECT id, session_id, host, host_session_id, observation_ids, channel, tokens, occurred_at FROM injections ORDER BY id').all()).toEqual([
      { id: 1, session_id: 1, host: 'claude-code', host_session_id: null, observation_ids: '[4]', channel: 'session_start', tokens: 9, occurred_at: 7 },
      { id: 2, session_id: 1, host: 'claude-code', host_session_id: null, observation_ids: '[]', channel: 'mcp', tokens: 1, occurred_at: 8 },
    ])
    expect(() => store.db.run("INSERT INTO injections (host, channel, tokens, occurred_at) VALUES ('x', 'start', 0, 0)")).toThrow()
    expect(store.db.query("SELECT name FROM sqlite_master WHERE name IN ('injections_v3', 'observer_fingerprints')").all()).toEqual([{ name: 'observer_fingerprints' }])
  } finally {
    store.db.close()
  }
})
