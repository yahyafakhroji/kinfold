import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { openTestDatabase } from '../sqlite/test-support'
import { openStore } from '../../store/db'
import { RECALL_INDEX, keywordCandidates, keywordIdsPlan } from '../../store/related-store'
import { MIGRATIONS } from '../../store/schema'
import { upsertProject, upsertSession } from '../../store/writes'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-migrate-v17-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('migration 16 -> 17 adds the index the keyword match filters through', () => {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const db = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 16)) db.run(sql)
  db.run('PRAGMA user_version = 16')
  db.close()
  const store = openStore(dataDir)
  try {
    expect(store.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(RECALL_INDEX)).toEqual({ name: RECALL_INDEX })
  } finally {
    store.db.close()
  }
})

test("the keyword match filters its hits through the index, never the rows' text, and reads full rows only for the ones it keeps", () => {
  const store = openStore(join(root, 'data'))
  try {
    upsertProject(store.db, { key: '/p', kind: 'path', displayName: 'p' }, 1)
    const session = upsertSession(store.db, { host: 'opencode', hostSessionId: 's', projectKey: '/p', cwd: '/p', occurredAt: 1 })
    const kept = seedObservation(store, { sessionId: session, projectKey: '/p', host: 'opencode', title: 'csv parser quotes', at: 1 })
    seedObservation(store, { sessionId: session, projectKey: '/p', host: 'opencode', title: 'csv parser quotes, older', at: 0 })
    expect(keywordIdsPlan(store.db)).toContain(`COVERING INDEX ${RECALL_INDEX}`)
    expect(keywordCandidates(store.db, { projectKey: '/p', match: 'csv', excludeIds: [kept + 1], excludeSessionId: null, limit: 5 }).map((row) => row.id)).toEqual([kept])
  } finally {
    store.db.close()
  }
})
