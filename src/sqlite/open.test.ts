import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openReadOnly } from '../context/fallback'
import type { CredentialProvider } from '../secrets/credentials'
import { openStore } from '../store/db'
import { upsertProject } from '../store/writes'
import { DB_KEYSTORE_ENV, type DbKeyStore, NO_DB_KEYS, credentialDbKeyStore, newDbKey, platformDbKeyStore } from './keys'
import { fileState, openEncrypted, openStoreFile } from './open'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-open-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const KEY = newDbKey()
const holding = (key: string | null): DbKeyStore => ({ name: 'test store', read: () => key, exists: () => key !== null })
const MARKER = 'ZEBRA-PLAINTEXT-MARKER'

function seed(keys: DbKeyStore): string {
  const store = openStore(dataDir, { keys })
  upsertProject(store.db, { key: MARKER, kind: 'path', displayName: MARKER }, 1)
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  store.db.close()
  return store.path
}

test('a new store is created encrypted when the key store has a key: no SQLite header, no plaintext in the file', () => {
  const path = seed(holding(KEY))
  expect(fileState(path)).toBe('encrypted')
  const bytes = readFileSync(path)
  expect(bytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3')
  expect(bytes.includes(MARKER)).toBe(false)
  const again = openStore(dataDir, { keys: holding(KEY) })
  expect(again.db.query<{ n: number }, []>('SELECT count(*) AS n FROM projects').get()!.n).toBe(1)
  again.db.close()
})

test('the wrong key and no key are both refused with a reason, and neither key appears in it', () => {
  const path = seed(holding(KEY))
  const other = newDbKey()
  expect(() => openStoreFile(path, { keys: holding(other) })).toThrow(expect.objectContaining({ kind: 'bad_key', code: 'SQLITE_NOTADB' }))
  expect(() => openStoreFile(path, { keys: holding(null) })).toThrow(expect.objectContaining({ kind: 'no_key', message: expect.stringContaining('sam key recover') }))
  try {
    openStoreFile(path, { keys: holding(other) })
  } catch (error: unknown) {
    expect(String((error as Error).message)).not.toContain(other)
    expect(String((error as Error).message)).not.toContain(KEY)
  }
  expect(() => openEncrypted(path, 'not hex')).toThrow(expect.objectContaining({ kind: 'bad_key' }))
})

test('a plaintext store stays plaintext even when a key exists, so existing installs open as before', () => {
  const path = seed(NO_DB_KEYS)
  expect(fileState(path)).toBe('plain')
  const again = openStore(dataDir, { keys: holding(KEY) })
  expect(fileState(path)).toBe('plain')
  again.db.close()
})

test('the read-only fallback opens an encrypted store with the key, plainly and through immutable=1', () => {
  const path = seed(holding(KEY))
  const errors: unknown[] = []
  const db = openReadOnly(path, (error) => errors.push(error), holding(KEY))
  expect(db).not.toBeNull()
  expect(db!.query<{ n: number }, []>('SELECT count(*) AS n FROM projects').get()!.n).toBe(1)
  db!.close()
  expect(openReadOnly(path, (error) => errors.push(error), holding(null))).toBeNull()
  expect(errors.at(-1)).toMatchObject({ kind: 'no_key' })
})

test('file states: missing and empty are new, the header is plain, anything else is encrypted', () => {
  expect(fileState(join(dataDir, 'missing.db'))).toBe('new')
  writeFileSync(join(dataDir, 'empty.db'), '')
  expect(fileState(join(dataDir, 'empty.db'))).toBe('new')
  writeFileSync(join(dataDir, 'short.db'), 'SQLite')
  expect(fileState(join(dataDir, 'short.db'))).toBe('encrypted')
})

test('the key store returns a hex key or null, and a failed or bad lookup never carries the value', () => {
  const provider = (value: string | null | Error): CredentialProvider => ({ get: () => { if (value instanceof Error) throw value; return value } })
  expect(credentialDbKeyStore('keychain', provider(KEY)).read()).toBe(KEY)
  expect(credentialDbKeyStore('keychain', provider(null)).read()).toBeNull()
  expect(() => credentialDbKeyStore('keychain', provider('SECRET-NOT-HEX'))).not.toThrow()
  expect(() => credentialDbKeyStore('keychain', provider('SECRET-NOT-HEX')).read()).toThrow(expect.objectContaining({ kind: 'no_key', message: expect.not.stringContaining('SECRET') }))
  expect(() => credentialDbKeyStore('keychain', provider(new Error('SECRET in stderr'))).read()).toThrow(expect.objectContaining({ kind: 'no_key', message: expect.not.stringContaining('SECRET') }))
  expect(platformDbKeyStore({ [DB_KEYSTORE_ENV]: 'none', NODE_ENV: 'test' }, 'darwin')).toBe(NO_DB_KEYS)
  // Outside bun test the switch does nothing: no environment can turn encryption off.
  expect(platformDbKeyStore({ [DB_KEYSTORE_ENV]: 'none' }, 'darwin').name).toBe('keychain')
  expect(platformDbKeyStore({}, 'linux')).toBe(NO_DB_KEYS)
  expect(newDbKey()).toMatch(/^[0-9a-f]{64}$/)
})

test('a new store with no key is refused where a real key store exists, so the key from sam install always comes first', () => {
  const named: DbKeyStore = { name: 'keychain', read: () => null, exists: () => false }
  expect(() => openStore(dataDir, { keys: named })).toThrow(expect.objectContaining({ kind: 'no_key', message: expect.stringContaining('run sam install') }))
  expect(fileState(join(dataDir, 'memory.db'))).toBe('new')
})

test('a file that cannot be read is an error, never a new store', () => {
  const path = join(dataDir, 'locked.db')
  writeFileSync(path, 'SQLite format 3\0 and more bytes')
  chmodSync(path, 0o000)
  try {
    expect(() => fileState(path)).toThrow()
  } finally {
    chmodSync(path, 0o600)
  }
})

const STOCK = '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib'
test.skipIf(!existsSync(STOCK))('a stock SQLite, which would ignore the key and write plaintext, is refused before anything opens', () => {
  const path = join(dataDir, 'stock.db')
  const script = `import { openEncrypted } from '${join(import.meta.dir, 'open.ts')}'
try { openEncrypted(${JSON.stringify(path)}, '${KEY}'); console.log('OPENED') } catch (e) { console.log(e.kind, e.message) }`
  const run = Bun.spawnSync([process.execPath, '-e', script], { env: { ...process.env, SAM_SQLITE3MC_LIB: STOCK }, stdout: 'pipe', stderr: 'pipe' })
  expect(run.stdout.toString().trim()).toBe('library the SQLite library is not a sqlite3mc build; run sam install')
  expect(existsSync(path)).toBe(false)
})
