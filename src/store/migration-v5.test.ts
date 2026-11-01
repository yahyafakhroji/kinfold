import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import type { Database } from '../sqlite/types'
import { openStore } from './db'
import { insertLinks, settleContradictions } from './observation-links'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v5-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A populated v4 store: three observations, one already contradicted by hand, a summary and an injection. */
function v4Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const v4 = openTestDatabase(join(dataDir, 'memory.db'))
  v4.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 4)) v4.run(sql)
  v4.run('PRAGMA user_version = 4')
  v4.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  v4.run("INSERT INTO sessions (host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES ('claude-code', 's', 'org/repo', '/w', 1, 2)")
  for (const [title, evidence, at] of [['old guess', 'interpretation', 1], ['tool result', 'tool-verified', 2], ['newest', 'tool-verified', 3]] as const) {
    v4.query(`INSERT INTO observations (project_key, session_id, host, type, title, evidence, content_hash, occurred_at, created_at)
              VALUES ('org/repo', 1, 'claude-code', 'discovery', ?, ?, ?, ?, ?)`).run(title, evidence, `h-${title}`, at, at)
  }
  v4.run('UPDATE observations SET contradicted_by = 2 WHERE id = 1')
  v4.run("INSERT INTO summaries (session_id, prompt_number, request, next_steps, occurred_at, updated_at) VALUES (1, 1, 'r', 'n', 1, 1)")
  v4.run("INSERT INTO injections (session_id, host, observation_ids, channel, tokens, occurred_at) VALUES (1, 'claude-code', '[1,2]', 'session_start', 5, 1)")
  v4.close()
}

const count = (db: Database, table: string): number => (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n

test('migration 4 -> 5 upgrades a populated v4 store in place: rows kept, links table empty and wired', () => {
  const dataDir = join(root, 'data')
  v4Database(dataDir)
  const store = openStore(dataDir)
  try {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(5)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(['observations', 'summaries', 'injections', 'sessions'].map((table) => count(store.db, table))).toEqual([3, 1, 1, 1])
    expect(store.db.query('SELECT id, contradicted_by AS by FROM observations ORDER BY id').all()).toEqual([
      { id: 1, by: 2 }, { id: 2, by: null }, { id: 3, by: null },
    ])
    expect(count(store.db, 'observation_links')).toBe(0)
    expect(store.db.query("SELECT rowid FROM observations_fts WHERE observations_fts MATCH 'guess'").all()).toEqual([{ rowid: 1 }])
    const fks = store.db.query("SELECT \"table\", \"from\", on_delete FROM pragma_foreign_key_list('observation_links') ORDER BY \"from\"").all()
    expect(fks).toEqual([
      { table: 'observations', from: 'from_id', on_delete: 'CASCADE' },
      { table: 'observations', from: 'to_id', on_delete: 'CASCADE' },
    ])
  } finally {
    store.db.close()
  }
})

test('after the upgrade, a link on old rows hides only what is not hidden yet, and deleting the newer row reveals the older', () => {
  const dataDir = join(root, 'data')
  v4Database(dataDir)
  const store = openStore(dataDir)
  try {
    expect(insertLinks(store.db, 3, [{ kind: 'contradicts', observationId: 1 }, { kind: 'updates', observationId: 2 }], 10)).toBe(2)
    expect(insertLinks(store.db, 3, [{ kind: 'updates', observationId: 2 }], 11)).toBe(0)
    expect(settleContradictions(store.db, [1, 2])).toBe(1)
    expect(store.db.query('SELECT id, contradicted_by AS by FROM observations ORDER BY id').all()).toEqual([
      { id: 1, by: 2 }, { id: 2, by: 3 }, { id: 3, by: null },
    ])
    store.db.run('DELETE FROM observations WHERE id = 3')
    expect(store.db.query('SELECT contradicted_by AS by FROM observations WHERE id = 2').get()).toEqual({ by: null })
    expect(count(store.db, 'observation_links')).toBe(0)
  } finally {
    store.db.close()
  }
})

test('a fresh store opens straight at v5 and refuses a link kind outside the list or to a missing row', () => {
  const store = openStore(join(root, 'fresh'))
  try {
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    store.db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('p', 'path', 'p', 1)")
    store.db.run("INSERT INTO observations (project_key, host, type, title, evidence, content_hash, occurred_at, created_at) VALUES ('p', 'h', 'discovery', 'a', 'tool-verified', 'a', 1, 1)")
    store.db.run("INSERT INTO observations (project_key, host, type, title, evidence, content_hash, occurred_at, created_at) VALUES ('p', 'h', 'discovery', 'b', 'tool-verified', 'b', 2, 2)")
    expect(() => store.db.run("INSERT INTO observation_links (from_id, to_id, kind, created_at) VALUES (2, 1, 'refines', 1)")).toThrow()
    expect(() => store.db.run("INSERT INTO observation_links (from_id, to_id, kind, created_at) VALUES (2, 99, 'updates', 1)")).toThrow()
  } finally {
    store.db.close()
  }
})
