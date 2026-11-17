import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-migrate-v16-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('migration 15 -> 16 keeps every project as its own, with no first commit yet, and adds the merge record', () => {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const db = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 15)) db.run(sql)
  db.run('PRAGMA user_version = 15')
  db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  db.close()
  const store = openStore(dataDir)
  try {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(16)
    expect(store.db.query('SELECT key, root_commit AS root, merged_into AS "into", merge_held AS held FROM projects').all()).toEqual([{ key: 'org/repo', root: null, into: null, held: 0 }])
    expect(store.db.query('SELECT count(*) AS n FROM project_merges').get()).toEqual({ n: 0 })
  } finally {
    store.db.close()
  }
})
