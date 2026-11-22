import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { openTestDatabase } from '../sqlite/test-support'
import type { Database } from '../sqlite/types'
import { openStore } from './db'
import { TURN_LAGS_SQL, turnLags } from './latency-reads'
import { RELATED_SQL, observationDetail } from './memory-reads'
import { linkTargets } from './observation-links'
import { CONTRADICTED_INDEX, MIGRATIONS, TURN_END_INDEX } from './schema'
import { upsertProject, upsertSession } from './writes'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-migrate-v19-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function plan(db: Database, sql: string, params: Record<string, string | number> = {}): string {
  return db.query<{ detail: string }, Record<string, string | number>>(`EXPLAIN QUERY PLAN ${sql}`).all(params).map((row) => row.detail).join('\n')
}

function rootPage(db: Database, index: string): number {
  return db.query<{ rootpage: number }, [string]>("SELECT rootpage FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)!.rootpage
}

test('migration 18 -> 19 adds both indexes to a database that already holds rows, and keeps the rows', () => {
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const old = openTestDatabase(join(dataDir, 'memory.db'))
  for (const sql of MIGRATIONS.slice(0, 18)) old.run(sql)
  old.run('PRAGMA user_version = 18')
  old.run("INSERT INTO projects (key, key_kind, display_name, created_at) VALUES ('/p', 'path', 'p', 1)")
  old.run("INSERT INTO sessions (id, host, host_session_id, project_key, cwd, started_at, last_event_at) VALUES (1, 'opencode', 's', '/p', '/p', 1, 1)")
  old.run("INSERT INTO events (event_id, session_id, kind, payload, content_hash, occurred_at, ingested_at) VALUES ('e1', 1, 'turn_end', '{}', 'h', 5, 6)")
  old.close()

  const store = openStore(dataDir)
  try {
    const names = store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name").all().map((row) => row.name)
    expect(names).toContain(CONTRADICTED_INDEX)
    expect(names).toContain(TURN_END_INDEX)
    expect(store.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version).toBe(MIGRATIONS.length)
    expect(store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM events WHERE kind = 'turn_end'").get()?.n).toBe(1)
  } finally {
    store.db.close()
  }
})

test('the turn_end read walks its own index instead of scanning and sorting every event', () => {
  const store = openStore(join(root, 'data'))
  try {
    expect(turnLags(store.db, 0)).toEqual([])
    const detail = plan(store.db, TURN_LAGS_SQL, { since: 0, limit: 10 })
    // Newest first straight off the index: no scan of events, and no sort of them (the one sort left orders a session's few runs).
    expect(detail).toContain(`SEARCH events USING INDEX ${TURN_END_INDEX}`)
    expect(detail).not.toContain('SCAN events')
    expect(detail.match(/TEMP B-TREE/g) ?? []).toHaveLength(1)
  } finally {
    store.db.close()
  }
})

test('deleting an observation finds the rows it had contradicted through the index, and so do the link and detail reads', () => {
  const store = openStore(join(root, 'data'))
  try {
    upsertProject(store.db, { key: '/p', kind: 'path', displayName: 'p' }, 1)
    const session = upsertSession(store.db, { host: 'opencode', hostSessionId: 's', projectKey: '/p', cwd: '/p', occurredAt: 1 })
    const older = seedObservation(store, { sessionId: session, projectKey: '/p', host: 'opencode', title: 'the port is 80', at: 1 })
    const newer = seedObservation(store, { sessionId: session, projectKey: '/p', host: 'opencode', title: 'the port is 8080', at: 2 })
    store.db.query('UPDATE observations SET contradicted_by = $by WHERE id = $id').run({ by: newer, id: older })

    // The ON DELETE SET NULL action runs as a subprogram of the DELETE; its child lookup opens the index's root page.
    const opened = store.db.query<{ opcode: string; p2: number }, []>('EXPLAIN DELETE FROM observations WHERE id = 1').all()
      .filter((row) => row.opcode === 'OpenRead' || row.opcode === 'OpenWrite').map((row) => row.p2)
    expect(opened).toContain(rootPage(store.db, CONTRADICTED_INDEX))

    expect(plan(store.db, 'SELECT id FROM observations WHERE contradicted_by IN (SELECT value FROM json_each($ids))', { ids: '[1]' })).toContain(CONTRADICTED_INDEX)
    expect(linkTargets(store.db, [newer])).toEqual([older])

    expect(observationDetail(store.db, newer)?.related.map((row) => [row.id, row.relation])).toEqual([[older, 'contradicts']])
    expect(observationDetail(store.db, older)?.related.map((row) => [row.id, row.relation])).toEqual([[newer, 'contradicted_by']])
    expect(plan(store.db, RELATED_SQL, { id: 1, by: 2 })).not.toContain('SCAN')

    store.db.query('DELETE FROM observations WHERE id = $id').run({ id: newer })
    expect(store.db.query<{ by: number | null }, { id: number }>('SELECT contradicted_by AS by FROM observations WHERE id = $id').get({ id: older })).toEqual({ by: null })
  } finally {
    store.db.close()
  }
})
