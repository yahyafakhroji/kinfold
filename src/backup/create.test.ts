import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DbKeyStore, newDbKey } from '../sqlite/keys'
import { fileState, openEncrypted } from '../sqlite/open'
import { encodeRecoveryCode } from '../sqlite/recovery'
import { HMAC_KEY_FILE, TOKEN_FILE, readOrCreateSecret } from '../store/data-dir'
import { type Store, openStore } from '../store/db'
import { LATEST_SCHEMA_VERSION } from '../store/schema'
import { BackupError, extractSnapshot, readArchive } from './archive'
import { BACKUP_TMP_DIR, createBackup } from './create'
import { BACKUP_RECORD_FILE, readBackupRecord } from './record'
import { snapshotInto } from './snapshot'

const NOW = 1_794_000_000_000

let root: string
let dataDir: string
let key: string
let store: Store
let dest: string

const keysOf = (value: string): DbKeyStore => ({ name: 'test', read: () => value, exists: () => true })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kf-create-'))
  dataDir = join(root, 'data')
  key = newDbKey()
  store = openStore(dataDir, { keys: keysOf(key) })
  store.db.run('CREATE TABLE filler (id INTEGER PRIMARY KEY, body TEXT NOT NULL)')
  store.db.run("INSERT INTO filler (body) VALUES ('remember this')")
  dest = join(root, 'memory.kfb')
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

const make = (overrides: Partial<Parameters<typeof createBackup>[0]> = {}): ReturnType<typeof createBackup> =>
  createBackup({ dataDir, dest, snapshot: (path) => snapshotInto(store.db, path), version: '0.2.0', now: () => NOW, ...overrides })

test('the backup holds the manifest and a snapshot that opens with the store key', async () => {
  const manifest = await make()
  expect(manifest).toMatchObject({ format: 1, kinfoldVersion: '0.2.0', schemaVersion: LATEST_SCHEMA_VERSION, createdAt: NOW, encrypted: true, settings: {} })
  const header = readArchive(dest)
  expect(header.manifest).toEqual(manifest)
  const out = join(root, 'out.db')
  await extractSnapshot(dest, header, out)
  expect(fileState(out)).toBe('encrypted')
  const copy = openEncrypted(out, key, { readonly: true })
  expect(copy.query<{ body: string }, []>('SELECT body FROM filler').get()!.body).toBe('remember this')
  copy.close()
})

test('the backup file holds no key, recovery code, token or HMAC key', async () => {
  const token = readOrCreateSecret(join(dataDir, TOKEN_FILE))
  const hmac = readOrCreateSecret(join(dataDir, HMAC_KEY_FILE))
  writeFileSync(join(dataDir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: false, firstInstalledAt: 1 }))
  writeFileSync(join(dataDir, 'key-store.json'), JSON.stringify({ store: 'key-file', chosenAt: 1, location: '/somewhere/private' }))
  await make()
  const bytes = readFileSync(dest)
  const code = encodeRecoveryCode(key)
  for (const secret of [key, code, code.replace(/-/g, ''), token, hmac]) expect(bytes.includes(Buffer.from(secret))).toBe(false)
  for (const secret of [key, token, hmac]) expect(bytes.includes(Buffer.from(secret, 'hex'))).toBe(false)
  // Machine records stay out: only the user's update-check choice travels.
  const manifest = readArchive(dest).manifest
  expect(manifest.settings).toEqual({ updateCheck: false })
  const manifestText = JSON.stringify(manifest)
  for (const machine of ['curl', 'key-file', '/somewhere/private', 'firstInstalledAt']) expect(manifestText).not.toContain(machine)
  // The plaintext memory is not readable from the file either.
  expect(bytes.includes(Buffer.from('remember this'))).toBe(false)
})

test('nothing is left in the temp folder, and the time is recorded', async () => {
  expect(readBackupRecord(dataDir)).toBeNull()
  await make()
  expect(readdirSync(join(dataDir, BACKUP_TMP_DIR))).toEqual([])
  expect(existsSync(`${dest}.partial`)).toBe(false)
  expect(readBackupRecord(dataDir)).toEqual({ lastBackupAt: NOW })
})

test('a failing snapshot leaves no file, no partial and no record', async () => {
  await expect(make({ snapshot: () => { throw new Error('disk full') } })).rejects.toThrow('disk full')
  expect(existsSync(dest)).toBe(false)
  expect(existsSync(`${dest}.partial`)).toBe(false)
  expect(readdirSync(join(dataDir, BACKUP_TMP_DIR))).toEqual([])
  expect(readBackupRecord(dataDir)).toBeNull()
})

test('an existing destination is refused and kept', async () => {
  writeFileSync(dest, 'mine')
  await expect(make()).rejects.toThrow(BackupError)
  expect(readFileSync(dest, 'utf8')).toBe('mine')
})

test('a damaged record reads as no backup', () => {
  writeFileSync(join(dataDir, BACKUP_RECORD_FILE), '{"lastBackupAt": "yesterday"}')
  expect(readBackupRecord(dataDir)).toBeNull()
  writeFileSync(join(dataDir, BACKUP_RECORD_FILE), 'nope')
  expect(readBackupRecord(dataDir)).toBeNull()
})
