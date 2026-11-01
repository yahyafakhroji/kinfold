import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { T0, seedSession } from '../observer/test-support'
import { openStore } from '../store/db'
import { upsertProject } from '../store/writes'
import { ConvertError, backupPath, convertStore } from './convert'
import { type DbKeyStore, NO_DB_KEYS, newDbKey } from './keys'
import { fileState, maintenancePath, openEncrypted, openPlain, openStoreFile } from './open'

let dataDir: string
let path: string
let logs: string[]
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-convert-'))
  path = join(dataDir, 'memory.db')
  logs = []
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const MARKER = 'ZEBRA-CONVERT-MARKER'
const holding = (key: string): DbKeyStore => ({ name: 'test', read: () => key, exists: () => true })
const PLENTY = () => Number.MAX_SAFE_INTEGER

/** A store with a project, a session and observations, so FTS and every table hold rows. */
function seed(keys: DbKeyStore): void {
  const store = openStore(dataDir, { keys })
  upsertProject(store.db, { key: MARKER, kind: 'path', displayName: MARKER }, T0)
  const session = seedSession(store, 'claude-code', 'convert')
  for (let i = 0; i < 25; i++) seedObservation(store, { sessionId: session, projectKey: MARKER, host: 'claude-code', title: `${MARKER} observation ${i}`, at: T0 + i })
  store.db.close()
}

function inMaintenance<T>(run: () => T): T {
  writeFileSync(maintenancePath(path), 'test')
  try {
    return run()
  } finally {
    rmSync(maintenancePath(path), { force: true })
  }
}

const count = (open: () => ReturnType<typeof openPlain>): number => {
  const db = open()
  try {
    return db.query<{ n: number }, []>('SELECT count(*) AS n FROM observations').get()!.n
  } finally {
    db.close()
  }
}

test('plaintext to encrypted keeps every row, leaves no plaintext and no backup, and opens only with the key', () => {
  seed(NO_DB_KEYS)
  const key = newDbKey()
  const result = inMaintenance(() => convertStore({ path, from: null, to: key, log: (line) => logs.push(line), freeBytes: PLENTY }))
  expect(result.rows).toBeGreaterThan(25)
  expect(fileState(path)).toBe('encrypted')
  expect(readFileSync(path).includes(MARKER)).toBe(false)
  expect(existsSync(backupPath(path))).toBe(false)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(count(() => openEncrypted(path, key))).toBe(25)
  expect(() => openEncrypted(path, newDbKey())).toThrow(expect.objectContaining({ kind: 'bad_key' }))
  expect(logs).toEqual([expect.stringMatching(/^convert: backup written/), 'convert: checked; backup removed'])
  expect(logs.join('\n')).not.toContain(key)
})

test('a new key, and back to plaintext, each keep every row', () => {
  const first = newDbKey()
  seed(holding(first))
  const second = newDbKey()
  inMaintenance(() => convertStore({ path, from: first, to: second, log: () => {}, freeBytes: PLENTY }))
  expect(() => openEncrypted(path, first)).toThrow(expect.objectContaining({ kind: 'bad_key' }))
  expect(count(() => openEncrypted(path, second))).toBe(25)
  inMaintenance(() => convertStore({ path, from: second, to: null, log: () => {}, freeBytes: PLENTY }))
  expect(fileState(path)).toBe('plain')
  expect(count(() => openPlain(path))).toBe(25)
})

test('a failure after the rekey puts the backup back, so the store is exactly as it was', () => {
  seed(NO_DB_KEYS)
  const before = readFileSync(path)
  const failing = () => convertStore({ path, from: null, to: newDbKey(), log: (line) => logs.push(line), freeBytes: PLENTY, afterRekey: () => { throw new Error('disk full') } })
  expect(() => inMaintenance(failing)).toThrow(ConvertError)
  expect(fileState(path)).toBe('plain')
  // The backup is taken once out of WAL mode, which rewrites the 100-byte file header (journal-mode
  // versions, change counter); every page after it comes back byte for byte.
  const after = readFileSync(path)
  expect(after.length).toBe(before.length)
  expect(after.subarray(100).equals(before.subarray(100))).toBe(true)
  expect(existsSync(backupPath(path))).toBe(false)
  expect(count(() => openPlain(path))).toBe(25)
  const reopened = openStore(dataDir, { keys: NO_DB_KEYS })
  expect(reopened.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()!.journal_mode).toBe('wal')
  reopened.db.close()
  expect(logs.at(-1)).toBe('convert: failed; the backup was put back')
})

test('another connection holding the store, even idle, makes the conversion refuse before anything changes', () => {
  seed(NO_DB_KEYS)
  const other = openPlain(path, { readonly: true })
  other.query('SELECT count(*) FROM observations').get()
  try {
    expect(() => inMaintenance(() => convertStore({ path, from: null, to: newDbKey(), log: () => {}, freeBytes: PLENTY }))).toThrow(expect.objectContaining({ stage: 'lock' }))
  } finally {
    other.close()
  }
  expect(fileState(path)).toBe('plain')
  expect(existsSync(backupPath(path))).toBe(false)
})

test('the checks refuse: no marker, the wrong state, the same key, too little space, an old backup', () => {
  seed(NO_DB_KEYS)
  const key = newDbKey()
  expect(() => convertStore({ path, from: null, to: key, log: () => {}, freeBytes: PLENTY })).toThrow('maintenance marker is missing')
  inMaintenance(() => {
    expect(() => convertStore({ path, from: key, to: newDbKey(), log: () => {}, freeBytes: PLENTY })).toThrow('memory.db is not encrypted')
    expect(() => convertStore({ path, from: null, to: null, log: () => {}, freeBytes: PLENTY })).toThrow('the same')
    expect(() => convertStore({ path, from: null, to: key, log: () => {}, freeBytes: () => 10 })).toThrow('not enough free space')
    writeFileSync(backupPath(path), 'old')
    expect(() => convertStore({ path, from: null, to: key, log: () => {}, freeBytes: PLENTY })).toThrow('exists from an earlier run')
  })
  expect(fileState(path)).toBe('plain')
})

test('while the marker is there, every other opener refuses the store', () => {
  seed(NO_DB_KEYS)
  inMaintenance(() => {
    expect(() => openStoreFile(path)).toThrow(expect.objectContaining({ kind: 'maintenance' }))
    expect(() => openStore(dataDir, { keys: NO_DB_KEYS })).toThrow(expect.objectContaining({ kind: 'maintenance' }))
  })
})
