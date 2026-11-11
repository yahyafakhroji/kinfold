import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from './db'
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './schema'
import { embeddingInputs, vectorCounts } from './vector-store'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-migrate-v11-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** A v10 store with three observations: two embedded under m1, one not embedded. */
function v10Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const v10 = openTestDatabase(join(dataDir, 'memory.db'))
  v10.run('PRAGMA journal_mode = WAL')
  for (const sql of MIGRATIONS.slice(0, 10)) v10.run(sql)
  v10.run('PRAGMA user_version = 10')
  v10.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  for (const id of [1, 2, 3]) {
    v10.query(`INSERT INTO observations (id, project_key, host, type, title, evidence, content_hash, occurred_at, created_at)
      VALUES (?, 'org/repo', 'claude-code', 'discovery', ?, 'tool-verified', ?, 1, 1)`).run(id, `title ${id}`, `hash ${id}`)
  }
  for (const id of [1, 2]) {
    v10.query("INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at) VALUES (?, 'm1', 2, zeroblob(8), 1)").run(id)
  }
  v10.close()
}

const indexes = (db: { query: (sql: string) => { all: () => unknown[] } }): string[] =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'observation_vectors' AND sql IS NOT NULL ORDER BY name").all() as { name: string }[])
    .map((row) => row.name)

test('migration 10 -> 11 indexes vectors by model, dims and observation, drops the model-only index, and keeps every row', () => {
  const dataDir = join(root, 'data')
  v10Database(dataDir)
  const store = openStore(dataDir)
  try {
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(11)
    expect(store.schemaVersion).toBe(LATEST_SCHEMA_VERSION)
    expect(indexes(store.db)).toEqual(['observation_vectors_by_space'])
    expect(store.db.query('SELECT observation_id AS id, model, dims FROM observation_vectors ORDER BY observation_id').all()).toEqual([
      { id: 1, model: 'm1', dims: 2 },
      { id: 2, model: 'm1', dims: 2 },
    ])
    expect((store.db.query('SELECT count(*) AS n FROM observations').get() as { n: number }).n).toBe(3)
    expect(embeddingInputs(store.db, { model: 'm1', dims: 2 }, 10).map((input) => input.id)).toEqual([3])
    expect(vectorCounts(store.db, { model: 'm1', dims: 2 })).toEqual({ indexed: 2, pending: 1 })
  } finally {
    store.db.close()
  }
})
