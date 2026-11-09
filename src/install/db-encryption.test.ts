import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import { DB_KEY_REF } from '../secrets/credentials'
import { type DbKeyStore, NO_DB_KEYS, newDbKey } from '../sqlite/keys'
import { openStore } from '../store/db'
import { DB_FILE } from '../store/data-dir'
import { createDbKey, dbKeyActions, dbStatusLines, describeCreateDbKey } from './db-encryption'
import { FDESETUP } from './disk/filevault'
import { stubDiskCheck } from './disk/stub-check'
import type { InstallEnv } from './env'
import { type FakeWorld, createWorld } from './test-support'

const worlds: FakeWorld[] = []
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.cleanup()
})
const world = (keychainRefs: string[] = []): FakeWorld => {
  const w = createWorld({ keychainRefs })
  worlds.push(w)
  return w
}

const holding = (key: string): DbKeyStore => ({ name: 'test', read: () => key, exists: () => true })
function seedStore(dataDir: string, keys: DbKeyStore): void {
  openStore(dataDir, { keys }).db.close()
}

const withFdesetup = (env: InstallEnv, stdout: string, exitCode = 0): InstallEnv => ({
  ...env,
  run: async (request) => (request.argv[0] === FDESETUP ? { exitCode, stdout } : env.run(request)),
})

test('a new data dir plans a db-key, made only when the step runs: on stdin, never replacing an entry, never printed', () => {
  const w = world()
  const path = join(w.dataDir, DB_FILE)
  expect(dbKeyActions(w.env)).toEqual([{ kind: 'create-db-key', path }])
  expect(describeCreateDbKey(path)).not.toMatch(/[0-9a-f]{64}/)
  createDbKey(w.env, path)
  expect(w.keychain.has(DB_KEY_REF)).toBe(true)
  const adds = w.securityCalls.filter((call) => call.stdin !== undefined)
  expect(adds).toHaveLength(1)
  expect(adds[0]!.args).toEqual(['-i'])
  expect(adds[0]!.stdin).toMatch(new RegExp(`^add-generic-password -s kinfold -a ${DB_KEY_REF} -w [0-9a-f]{64}\\n$`))
  const value = adds[0]!.stdin!.trim().split(' ').at(-1)!
  expect(w.securityCalls.some((call) => call.args.join(' ').includes(value))).toBe(false)
  expect(w.out.join('\n')).not.toContain(value)
})

test('an existing entry is kept, and a store that appeared while install ran gets no key', () => {
  const kept = world([DB_KEY_REF])
  expect(dbKeyActions(kept.env)).toEqual([])
  createDbKey(kept.env, join(kept.dataDir, DB_FILE))
  expect(kept.securityCalls.filter((call) => call.stdin !== undefined)).toEqual([])
  expect(kept.out).toContain(`database: keychain entry ${DB_KEY_REF} exists already; kept it`)
  const raced = world()
  seedStore(raced.dataDir, NO_DB_KEYS)
  createDbKey(raced.env, join(raced.dataDir, DB_FILE))
  expect(raced.keychain.has(DB_KEY_REF)).toBe(false)
  expect(raced.out.some((line) => line.includes('appeared while install ran; no key was created'))).toBe(true)
})

test('an existing store is never touched, plaintext or encrypted', () => {
  const plain = world()
  seedStore(plain.dataDir, NO_DB_KEYS)
  expect(dbKeyActions(plain.env)).toEqual([])
  expect(plain.out.some((line) => line.includes('plaintext; it stays that way until kinfold encrypt'))).toBe(true)
  const encrypted = world()
  seedStore(encrypted.dataDir, holding(newDbKey()))
  expect(dbKeyActions(encrypted.env)).toEqual([])
})

test('without a Keychain there is no key, and the new store is plaintext', () => {
  const { env, out } = world()
  expect(dbKeyActions({ ...env, platform: 'linux' })).toEqual([])
  expect(out.some((line) => line.includes('no key store on linux yet'))).toBe(true)
})

test('status names how the store is kept and whether its key entry exists, from metadata only, and warns on a mismatch', async () => {
  const fresh = world()
  expect(await dbStatusLines(withFdesetup(fresh.env, 'FileVault is On.\n'))).toEqual(['database: not created yet (keychain db-key missing)', 'disk encryption: FileVault on'])
  const plainWithKey = world([DB_KEY_REF])
  seedStore(plainWithKey.dataDir, NO_DB_KEYS)
  const lines = await dbStatusLines(withFdesetup(plainWithKey.env, 'FileVault is On.\n'))
  expect(lines.slice(0, 2)).toEqual(['database: plaintext; kinfold encrypt converts it (keychain db-key present)', expect.stringContaining('warning: memory.db is plaintext but the Keychain holds db-key')])
  expect(plainWithKey.securityCalls.every((call) => !call.args.includes('-w'))).toBe(true)
  const lost = world()
  seedStore(lost.dataDir, holding(newDbKey()))
  expect((await dbStatusLines(withFdesetup(lost.env, 'FileVault is On.\n'))).slice(0, 2)).toEqual(['database: encrypted (keychain db-key missing)', expect.stringContaining('restore it with kinfold key recover')])
})

test('FileVault off is a warning; a failed check says so; other platforms print no disk line yet', async () => {
  const { env } = world()
  expect((await dbStatusLines(withFdesetup(env, 'FileVault is Off.\n'))).at(-1)).toMatch(/^warning: FileVault is off; the spool, logs and agent transcripts are unencrypted/)
  expect((await dbStatusLines(withFdesetup(env, '', 1))).at(-1)).toBe('disk encryption: could not check (fdesetup exit 1)')
  expect(await dbStatusLines({ ...env, platform: 'linux', diskCheck: stubDiskCheck('Test') })).toEqual(['database: not created yet (no key store)'])
})
