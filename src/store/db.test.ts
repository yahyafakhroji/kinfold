import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import type { Database } from '../sqlite/types'
import { readOrCreateSecret } from './data-dir'
import { type Store, migrate, openStore } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, MIGRATION_STEPS } from './schema'
import { posixOnly } from '../../test/platform-guards'

let root: string
let dataDir: string
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-store-'))
  dataDir = join(root, 'data')
  store = openStore(dataDir)
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

const pragma = (name: string): unknown => Object.values(store.db.query(`PRAGMA ${name}`).get() as object)[0]
const mode = (path: string): number => statSync(path).mode & 0o777

test('the store runs with WAL, secure_delete, incremental auto_vacuum and foreign keys', () => {
  expect(pragma('journal_mode')).toBe('wal')
  expect(pragma('secure_delete')).toBe(1)
  expect(pragma('auto_vacuum')).toBe(2) // 2 = INCREMENTAL
  expect(pragma('foreign_keys')).toBe(1)
  expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
})

posixOnly('file modes')('the data dir is 0700 and the database, WAL and SHM files are 0600', () => {
  store.db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('k', 'path', 'k', 1)")
  expect(mode(dataDir)).toBe(0o700)
  for (const suffix of ['', '-wal', '-shm']) expect(mode(`${store.path}${suffix}`)).toBe(0o600)
})

test('migrations are idempotent and reopening keeps the data', () => {
  store.db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('k', 'path', 'k', 1)")
  expect(migrate(store.db)).toBe(LATEST_SCHEMA_VERSION)
  store.db.close()
  store = openStore(dataDir)
  expect(store.db.query('SELECT key FROM projects').all()).toEqual([{ key: 'k' }])
})

test('a database from a newer build is refused', () => {
  store.db.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`)
  expect(() => migrate(store.db)).toThrow('newer than this build')
})

test('observations_fts finds an inserted observation, follows an update and drops a deleted one', () => {
  const db = store.db
  db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  db.run(`INSERT INTO observations (project_key, host, type, title, narrative, facts, evidence, content_hash, occurred_at, created_at)
          VALUES ('org/repo', 'claude-code', 'discovery', 'Spool drain order', 'entries sort by host time', '["ulid tiebreak"]',
                  'tool-verified', 'h', 1, 1)`)
  const search = (term: string): unknown[] =>
    db.query('SELECT rowid FROM observations_fts WHERE observations_fts MATCH $term').all({ term })

  expect(search('drain')).toHaveLength(1)
  expect(search('tiebreak')).toHaveLength(1)
  db.run("UPDATE observations SET title = 'Quarantine handling' WHERE id = 1")
  expect(search('drain')).toHaveLength(0)
  expect(search('quarantine')).toHaveLength(1)
  db.run('DELETE FROM observations WHERE id = 1')
  expect(search('quarantine')).toHaveLength(0)
  expect(search('tiebreak')).toHaveLength(0)
})

posixOnly('file modes')('a secret file is created once at 0600 and read back unchanged', () => {
  const path = join(dataDir, 'daemon.token')
  const first = readOrCreateSecret(path)
  expect(first).toMatch(/^[0-9a-f]{64}$/)
  expect(mode(path)).toBe(0o600)
  expect(readOrCreateSecret(path)).toBe(first)
})

test('a migration step that throws rolls back its SQL too: user_version and columns stay at the previous version', () => {
  const v6 = openTestDatabase(':memory:')
  for (const sql of MIGRATIONS.slice(0, 6)) v6.run(sql)
  v6.run('PRAGMA user_version = 6')
  const steps = MIGRATION_STEPS as Record<number, (db: Database) => void>
  const real = steps[7]!
  steps[7] = () => {
    throw new Error('step failed')
  }
  try {
    expect(() => migrate(v6)).toThrow('step failed')
  } finally {
    steps[7] = real
  }
  expect((v6.query('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(6)
  expect(v6.query("SELECT 1 FROM pragma_table_info('prompts') WHERE name = 'text_hash'").get()).toBeNull()
  expect(migrate(v6)).toBe(LATEST_SCHEMA_VERSION)
  v6.close()
})
