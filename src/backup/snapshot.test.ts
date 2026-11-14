import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rowCounts } from '../sqlite/convert'
import { type DbKeyStore, newDbKey } from '../sqlite/keys'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { fileState, maintenancePath, openEncrypted, openPlain } from '../sqlite/open'
import type { Database } from '../sqlite/types'
import { type Store, openStore } from '../store/db'
import { LATEST_SCHEMA_VERSION } from '../store/schema'
import { BackupError } from './archive'
import { snapshotInWorker, snapshotInto, snapshotStoreFile } from './snapshot'

let dir: string
let key: string
let store: Store
let dest: string

const keysOf = (value: string): DbKeyStore => ({ name: 'test', read: () => value, exists: () => true })
const library = (): string | null => process.env[SQLITE3MC_LIB_ENV] ?? null

function fill(db: Database, rows: number, from = 0): void {
  db.transaction(() => {
    for (let index = from; index < from + rows; index += 1) db.run('INSERT INTO filler (id, body) VALUES (?, ?)', index, 'x'.repeat(900))
  })()
}

function countOf(db: Database): number {
  return db.query<{ n: number }, []>('SELECT count(*) AS n FROM filler').get()!.n
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kf-snapshot-'))
  key = newDbKey()
  store = openStore(dir, { keys: keysOf(key) })
  store.db.run('CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  dest = join(dir, 'snapshot.db')
})
afterEach(() => {
  store.db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('a snapshot of an encrypted store is encrypted and opens with the same key only', () => {
  fill(store.db, 50)
  snapshotInto(store.db, dest)
  expect(fileState(dest)).toBe('encrypted')
  const snapshot = openEncrypted(dest, key, { readonly: true })
  expect(snapshot.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(LATEST_SCHEMA_VERSION)
  expect(snapshot.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
  expect([...rowCounts(snapshot)]).toEqual([...rowCounts(store.db)])
  snapshot.close()
  expect(() => openEncrypted(dest, newDbKey(), { readonly: true })).toThrow()
  expect(() => openPlain(dest, { readonly: true }).query('SELECT count(*) FROM sqlite_master').get()).toThrow()
})

test('the snapshot is one owner-only file with no side files', () => {
  fill(store.db, 5)
  snapshotInto(store.db, dest)
  expect(existsSync(`${dest}-wal`)).toBe(false)
  expect(existsSync(`${dest}-journal`)).toBe(false)
  if (process.platform !== 'win32') expect(statSync(dest).mode & 0o777).toBe(0o600)
})

test('a plaintext store gives a plaintext snapshot', () => {
  const plainDir = mkdtempSync(join(tmpdir(), 'kf-snapshot-plain-'))
  const plain = openStore(plainDir)
  try {
    snapshotInto(plain.db, join(plainDir, 'snapshot.db'))
    expect(fileState(join(plainDir, 'snapshot.db'))).toBe('plain')
  } finally {
    plain.db.close()
    rmSync(plainDir, { recursive: true, force: true })
  }
})

test('an existing destination is refused, never replaced', () => {
  writeFileSync(dest, 'mine')
  expect(() => snapshotInto(store.db, dest)).toThrow(BackupError)
  expect(statSync(dest).size).toBe(4)
})

test('snapshotStoreFile reads through its own connection while the store stays open', () => {
  fill(store.db, 20)
  snapshotStoreFile({ dbPath: store.path, key, dest })
  const snapshot = openEncrypted(dest, key, { readonly: true })
  expect(countOf(snapshot)).toBe(20)
  snapshot.close()
})

test('snapshotStoreFile refuses while the maintenance marker is there', () => {
  writeFileSync(maintenancePath(store.path), '{}')
  expect(() => snapshotStoreFile({ dbPath: store.path, key, dest })).toThrow(BackupError)
  expect(existsSync(dest)).toBe(false)
})

test('a wrong key fails without leaving a file and without naming the key', () => {
  const wrong = newDbKey()
  let message = ''
  try {
    snapshotStoreFile({ dbPath: store.path, key: wrong, dest })
  } catch (error: unknown) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).not.toBe('')
  expect(message).not.toContain(wrong)
  expect(existsSync(dest)).toBe(false)
})

test('the worker writes the same snapshot', async () => {
  fill(store.db, 30)
  await snapshotInWorker({ dbPath: store.path, key, dest, libraryOverride: library() })
  const snapshot = openEncrypted(dest, key, { readonly: true })
  expect(countOf(snapshot)).toBe(30)
  snapshot.close()
})

test('a worker failure rejects with a fixed reason that holds no key', async () => {
  const wrong = newDbKey()
  const failure = await snapshotInWorker({ dbPath: store.path, key: wrong, dest, libraryOverride: library() }).then(() => null, (error: unknown) => error as Error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure!.message).not.toContain(wrong)
  expect(existsSync(dest)).toBe(false)
})

test('a snapshot taken while the store is being written is whole and holds every row committed before it began', async () => {
  const before = 20_000
  fill(store.db, before)
  let written = before
  let done = false
  const snapshot = snapshotInWorker({ dbPath: store.path, key, dest, libraryOverride: library() }).finally(() => {
    done = true
  })
  // The daemon's writer keeps committing while the worker copies.
  while (!done) {
    fill(store.db, 25, written)
    written += 25
    await Bun.sleep(0)
  }
  await snapshot
  expect(written).toBeGreaterThan(before)
  const copy = openEncrypted(dest, key, { readonly: true })
  expect(copy.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
  const rows = countOf(copy)
  expect(rows).toBeGreaterThanOrEqual(before)
  expect(rows).toBeLessThanOrEqual(written)
  // One point in time: the ids are exactly 0..rows-1, with no gap from a half-copied commit.
  expect(copy.query<{ top: number }, []>('SELECT max(id) AS top FROM filler').get()!.top).toBe(rows - 1)
  expect(rows % 25).toBe(0)
  copy.close()
})
