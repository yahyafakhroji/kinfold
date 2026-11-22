import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqlFor } from '../../mcp/reader'
import { openTestDatabase } from '../../../resources/tests/sqlite/test-support'
import type { Database } from '../../../resources/sqlite/types'
import { openStore } from '../../../resources/store/db'
import { MIGRATIONS, SUMMARIES_TIME_INDEX } from '../../../resources/store/schema'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-migrate-v20-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function plan(db: Database, sql: string, params: Record<string, string | number | null>): string {
  return db.query<{ detail: string }, Record<string, string | number | null>>(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((row) => row.detail).join('\n')
}

test('migration 19 -> 20 adds the summaries index to a database that already holds summaries, and keeps them', () => {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const old = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 19)) old.run(sql)
  old.run('PRAGMA user_version = 19')
  old.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('/p', 'path', 'p', 1)")
  old.run("INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES (1, 'opencode', 's', '/p', '/p', 1, 1)")
  old.run("INSERT INTO summaries (session_id, prompt_number, request, occurred_at, updated_at) VALUES (1, 1, 'pin bun', 5, 5)")
  old.close()

  const store = openStore(dataDir)
  try {
    const names = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((row) => row.name)
    expect(names).toContain(SUMMARIES_TIME_INDEX)
    expect(store.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(MIGRATIONS.length)
    expect(store.db.query<{ request: string }, []>('SELECT request FROM summaries').all()).toEqual([{ request: 'pin bun' }])
  } finally {
    store.db.close()
  }
})

test('the timeline reads the summaries around a moment through the index: no scan of the table and no sort', () => {
  const store = openStore(join(root, 'data'))
  try {
    for (const features of [{ hasLinks: true, hasSharing: true }, { hasLinks: false, hasSharing: false }]) {
      const sql = sqlFor(features)
      for (const [name, project] of [['summariesBefore', null], ['summariesAfter', null], ['summariesBefore', '/p'], ['summariesAfter', '/p']] as const) {
        const detail = plan(store.db, sql[name], { at: 100, project, limit: 10 })
        expect(detail).toContain(SUMMARIES_TIME_INDEX)
        expect(detail).not.toContain('SCAN m')
        expect(detail).not.toContain('TEMP B-TREE')
      }
    }
  } finally {
    store.db.close()
  }
})
