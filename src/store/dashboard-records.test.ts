import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ingestResolved } from '../daemon/ingest'
import { listActivity } from './activity-store'
import { recordInjection } from './context-store'
import { type Store, openStore } from './db'
import { LOCAL_DEVICE, upsertProject, upsertSession } from './writes'

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-records-'))
  store = openStore(join(root, 'data'))
  upsertProject(store.db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, 1)
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

function observation(id: number): void {
  store.db.run(`INSERT INTO observations (id, project_key, host, type, title, evidence, content_hash, occurred_at, created_at)
    VALUES (${id}, 'org/repo', 'claude-code', 'discovery', 't${id}', 'tool-verified', 'h${id}', 1, 1)`)
}

const counts = (): unknown[] => store.db.query('SELECT id, recall_count AS n FROM observations ORDER BY id').all()

test('a delivered injection counts once for each memory it carries and is logged as a recall', () => {
  observation(1)
  observation(2)
  const sessionId = upsertSession(store.db, { host: 'claude-code', hostSessionId: 's1', projectKey: 'org/repo', cwd: '/w', occurredAt: 1 })
  const base = { sessionId, host: 'claude-code', hostSessionId: 's1', projectKey: 'org/repo', tokens: 10, occurredAt: 50 }
  recordInjection(store.db, { ...base, observationIds: [1, 2], channel: 'session_start' })
  recordInjection(store.db, { ...base, observationIds: [1], channel: 'prompt', promptNumber: 1 })
  // Late: probably never shown. Held out: carries no ids. Empty: nothing to count.
  recordInjection(store.db, { ...base, observationIds: [2], channel: 'prompt', promptNumber: 2, late: true })
  recordInjection(store.db, { ...base, observationIds: [], channel: 'prompt', promptNumber: 3, heldOut: true })
  expect(counts()).toEqual([{ id: 1, n: 2 }, { id: 2, n: 1 }])
  const rows = listActivity(store.db, { kinds: null, limit: 10, offset: 0 }).rows
  expect(rows.map((row) => [row.kind, row.count, row.sessionId])).toEqual([['recall', 1, sessionId], ['recall', 2, sessionId]])
})

test('a session keeps the device it was first captured on', () => {
  const id = upsertSession(store.db, { host: 'codex', hostSessionId: 's2', projectKey: 'org/repo', cwd: '/w', occurredAt: 1, device: 'dev-a' })
  upsertSession(store.db, { host: 'codex', hostSessionId: 's2', projectKey: 'org/repo', cwd: '/w', occurredAt: 2, device: 'dev-b' })
  upsertSession(store.db, { host: 'codex', hostSessionId: 's3', projectKey: 'org/repo', cwd: '/w', occurredAt: 2 })
  expect(store.db.query('SELECT id, device FROM sessions ORDER BY id').all()).toEqual([{ id, device: 'dev-a' }, { id: id + 1, device: null }])
})

test('a hub stores the capturing device on the session; a local drain stores the local mark', () => {
  const event = { eventId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', host: 'codex', hostSessionId: 'h1', cwd: '/w', kind: 'session_start', occurredAt: 5 } as const
  ingestResolved(store.db, [{ event: event as never, project: { key: 'org/repo', kind: 'git-remote', displayName: 'repo' } }], { device: 'dev-x', now: () => 9 } as never)
  expect(store.db.query("SELECT device FROM sessions WHERE host_session_id = 'h1'").get()).toEqual({ device: 'dev-x' })
  expect(LOCAL_DEVICE).toBe('local')
})
