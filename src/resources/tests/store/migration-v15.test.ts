import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from '../../store/db'
import { MIGRATIONS } from '../../store/schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-migrate-v15-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const VECTOR = new Uint8Array(new Float32Array([1, 0]).buffer)

/** A v14 store with three observations, both embedded by OpenRouter and one by an older model too few to matter. */
function v14Database(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true })
  const db = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 14)) db.run(sql)
  db.run('PRAGMA user_version = 14')
  db.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('org/repo', 'git-remote', 'repo', 1)")
  db.run("INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES (1, 'claude-code', 's1', 'org/repo', '/w', 100, 900)")
  for (const id of [7, 8, 9]) {
    db.run(`INSERT INTO observations (id, project_key, session_id, host, prompt_number, type, title, evidence, content_hash, occurred_at, created_at)
      VALUES (${id}, 'org/repo', 1, 'claude-code', 1, 'discovery', 't${id}', 'tool-verified', 'h${id}', 100, 100)`)
  }
  const insert = db.prepare('INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at) VALUES (?, ?, 2, ?, 5)')
  insert.run(7, 'openai/text-embedding-3-small', VECTOR)
  insert.run(8, 'openai/text-embedding-3-small', VECTOR)
  insert.run(9, 'old-model', VECTOR)
  db.close()
}

test('migration 14 -> 15 keeps every vector, allows two spaces per observation and marks the largest space active', () => {
  const dataDir = join(root, 'data')
  v14Database(dataDir)
  const store = openStore(dataDir)
  try {
    const { db } = store
    expect(db.query('SELECT observation_id AS id, model FROM observation_vectors ORDER BY observation_id').all()).toEqual([
      { id: 7, model: 'openai/text-embedding-3-small' },
      { id: 8, model: 'openai/text-embedding-3-small' },
      { id: 9, model: 'old-model' },
    ])
    db.prepare("INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at) VALUES (7, 'local/all-MiniLM-L6-v2', 2, ?, 6)").run(VECTOR)
    expect(db.query('SELECT count(*) AS n FROM observation_vectors WHERE observation_id = 7').get()).toEqual({ n: 2 })
    expect(() => db.prepare("INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at) VALUES (7, 'local/all-MiniLM-L6-v2', 2, ?, 6)").run(VECTOR)).toThrow()
    expect(db.query('SELECT model, dims, state FROM vector_spaces').all()).toEqual([{ model: 'openai/text-embedding-3-small', dims: 2, state: 'active' }])
    expect(db.query('SELECT count(*) AS n FROM embedding_settings').get()).toEqual({ n: 0 })
    db.run('DELETE FROM observations WHERE id = 7')
    expect(db.query('SELECT count(*) AS n FROM observation_vectors WHERE observation_id = 7').get()).toEqual({ n: 0 })
  } finally {
    store.db.close()
  }
})

test('a store with no vectors starts with no space', () => {
  const dataDir = join(root, 'fresh')
  const store = openStore(dataDir)
  try {
    expect(store.db.query('SELECT count(*) AS n FROM vector_spaces').get()).toEqual({ n: 0 })
  } finally {
    store.db.close()
  }
})
