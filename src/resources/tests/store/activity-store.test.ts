import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACTIVITY_MAX_AGE_MS, listActivity, pruneActivity, recordActivity } from '../../store/activity-store'
import { type Store, openStore } from '../../store/db'

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-activity-'))
  store = openStore(join(root, 'data'))
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

test('rows come back newest first, filtered by kind, with a total for the pager', () => {
  recordActivity(store.db, { kind: 'recall', at: 100, host: 'claude-code', projectKey: 'org/repo', sessionId: 1, count: 3 })
  recordActivity(store.db, { kind: 'save', at: 200, host: 'claude-code', count: 2 })
  recordActivity(store.db, { kind: 'observer-failed', at: 300, host: 'codex', detail: 'rate-limit' })
  const all = listActivity(store.db, { kinds: null, limit: 50, offset: 0 })
  expect(all.total).toBe(3)
  expect(all.rows.map((row) => row.kind)).toEqual(['observer-failed', 'save', 'recall'])
  expect(all.rows[2]).toEqual({ id: 1, at: 100, kind: 'recall', host: 'claude-code', projectKey: 'org/repo', project: 'org/repo', sessionId: 1, device: null, count: 3, detail: null })
  const some = listActivity(store.db, { kinds: ['recall', 'save'], limit: 1, offset: 1 })
  expect(some).toEqual({ total: 2, rows: [expect.objectContaining({ kind: 'recall' })] })
})

test('detail keeps a short machine word only, so no memory text can land in the table', () => {
  recordActivity(store.db, { kind: 'update-installed', at: 1, detail: '0.6.1' })
  recordActivity(store.db, { kind: 'observer-failed', at: 2, detail: 'the model said: my password is hunter2' })
  expect(listActivity(store.db, { kinds: null, limit: 50, offset: 0 }).rows.map((row) => row.detail)).toEqual([null, '0.6.1'])
})

test('an unknown kind is refused', () => {
  expect(() => recordActivity(store.db, { kind: 'whatever' as never, at: 1 })).toThrow()
})

test('pruning drops rows past the age limit and past the row cap, oldest first', () => {
  const now = 10 * ACTIVITY_MAX_AGE_MS
  recordActivity(store.db, { kind: 'backup', at: now - ACTIVITY_MAX_AGE_MS - 1 })
  for (let at = 1; at <= 5; at += 1) recordActivity(store.db, { kind: 'save', at: now - 10 + at })
  expect(pruneActivity(store.db, now, 3)).toBe(3)
  expect(listActivity(store.db, { kinds: null, limit: 50, offset: 0 }).rows.map((row) => row.at)).toEqual([now - 5, now - 6, now - 7])
})

test('every thousandth row prunes on its own', () => {
  recordActivity(store.db, { kind: 'backup', at: 1 })
  store.db.run('INSERT INTO activity (id, at, kind) VALUES (999, 2, \'backup\')')
  recordActivity(store.db, { kind: 'backup', at: Date.now() })
  expect(listActivity(store.db, { kinds: null, limit: 50, offset: 0 }).rows.map((row) => row.id)).toEqual([1000])
})
