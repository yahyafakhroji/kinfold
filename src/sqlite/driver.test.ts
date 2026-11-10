// close() must release the file even while statements are still referenced.
// On Windows a store whose close left a statement alive cannot be deleted
// (EBUSY); on POSIX the delete succeeds either way, so there the statements
// used after close are what the test checks.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUERY_CACHE_LIMIT } from './driver'
import { openTestDatabase } from './test-support'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-driver-close-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('close releases the file while prepared and cache-evicted statements are still held', () => {
  const path = join(dir, 'memory.db')
  const db = openTestDatabase(path)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE t(v INTEGER); INSERT INTO t VALUES (1), (2)')
  // Never finalized by the caller, as a long-lived reader's statements are not.
  const prepared = db.prepare<{ v: number }, []>('SELECT v FROM t ORDER BY v')
  expect(prepared.all()).toEqual([{ v: 1 }, { v: 2 }])
  // Pushed out of the query cache while still held.
  const evicted = db.query<{ n: number }, []>('SELECT count(*) AS n FROM t')
  expect(evicted.get()).toEqual({ n: 2 })
  for (let i = 0; i <= QUERY_CACHE_LIMIT; i++) db.query(`SELECT ${i} AS v`).get()

  db.close()
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true })
  expect(existsSync(path)).toBe(false)

  expect(() => prepared.all()).toThrow('database is closed')
  expect(() => evicted.get()).toThrow('database is closed')
})
