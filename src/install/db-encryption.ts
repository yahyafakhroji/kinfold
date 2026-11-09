// Database encryption in `kinfold install` and `kinfold status`. On a
// data dir with no memory.db yet, install puts a new random key in the
// key store (db-key), so the daemon creates the store encrypted
// (src/sqlite/open.ts). An existing store is never touched here: `kinfold
// encrypt` converts it (E3). Status reads the file's header and key store
// metadata only, never the key, and warns when FileVault is off, since the
// spool, logs and host transcripts sit outside memory.db.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DB_KEY_NEXT_REF, DB_KEY_REF, KEYCHAIN_SERVICE } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import { createKeychainStore } from '../secrets/stores/keychain'
import { NO_DB_KEYS, newDbKey } from '../sqlite/keys'
import { foundBackupPath } from '../sqlite/convert'
import { fileState, maintenancePath } from '../sqlite/open'
import { DB_FILE } from '../store/data-dir'
import { openStore } from '../store/db'
import { type InstallEnv, errorMessage, platformOf } from './env'
import { keyStoreOf, readKeyStore } from './key-store-choice'
import { ChoiceError } from './observer-choice'
import type { Action } from './plan'
import type { EncryptionAnswer } from './setup/wizard'

export const FDESETUP = '/usr/bin/fdesetup'

const foundLine = (store: KeyStore): string => `database: ${store.label} entry ${DB_KEY_REF} found; the new store is created encrypted with it`
const newKeyLine = (store: KeyStore): string => `database: the new store is created encrypted; its key goes in ${store.place}`

/** The key for a store the daemon has yet to create; nothing for an existing store or without a key store. */
export function dbKeyActions(env: InstallEnv): Action[] {
  const path = join(env.dataDir, DB_FILE)
  const state = fileState(path)
  if (state === 'plain') {
    env.out(`database: ${path} is plaintext; it stays that way until kinfold encrypt`)
    return []
  }
  if (state === 'encrypted') return []
  const store = keyStoreOf(env)
  if (store === null) {
    env.out(`database: no key store on ${env.platform} yet; the new store is created plaintext`)
    return []
  }
  if (store.exists(DB_KEY_REF)) {
    env.out(foundLine(store))
    return []
  }
  env.out(newKeyLine(store))
  return [{ kind: 'create-db-key', path }]
}

type StoreWords = Pick<KeyStore, 'place' | 'describeEntry'>

export function dbKeyMismatch(store: StoreWords): string {
  return `${store.place} already holds ${DB_KEY_REF}, so the recovery code shown does not open this store; run kinfold key show-recovery`
}

/** No store exists to show a code for, so the way out is the entry itself, named and never read out. */
export function staleDbKey(store: StoreWords): string {
  return `${store.place} already holds a database key that no memory.db uses, and its recovery code cannot be recomputed from it; nothing was changed.`
    + ` If no copy of memory.db needs it, delete ${store.describeEntry(DB_KEY_REF)}, then run install again`
}

// Describing never runs `security`, so this store only lends its wording.
const KEYCHAIN_WORDS: StoreWords = createKeychainStore(() => {
  throw new Error('the Keychain wording runs no command')
})

/** The Keychain's wording of each message, which macOS prints. */
export const DB_KEY_MISMATCH = dbKeyMismatch(KEYCHAIN_WORDS)
export const STALE_DB_KEY = staleDbKey(KEYCHAIN_WORDS)

const HEX_KEY = /^[0-9a-f]{64}$/

export type StoredDbKey = { kind: 'none' } | { kind: 'usable'; key: string } | { kind: 'unreadable' }

/** The db-key already in the key store, if any; its recovery code can be recomputed only from a well-formed key. */
export function storedDbKey(env: InstallEnv): StoredDbKey {
  try {
    const store = keyStoreOf(env)
    if (store === null || !store.exists(DB_KEY_REF)) return { kind: 'none' }
    const value = store.get(DB_KEY_REF)
    return value !== null && HEX_KEY.test(value) ? { kind: 'usable', key: value } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  }
}

/**
 * The store's key as the setup answered it. A new encrypted store takes the
 * key whose code was shown, or under --yes a key made at run time; a usable
 * db-key already in the key store is used again rather than replaced, since
 * a second key would orphan whatever it opens. A new plaintext store is
 * created before the daemon starts, because the daemon creates a missing
 * store encrypted wherever a key store exists. An existing store keeps its
 * key here; the encrypt and decrypt flows change it after the plan.
 */
export function setupDbKeyActions(env: InstallEnv, encryption: EncryptionAnswer): Action[] {
  if (encryption.kind === 'keep') return dbKeyActions(env)
  if (encryption.kind === 'encrypt-existing' || encryption.kind === 'decrypt-existing') return []
  const path = join(env.dataDir, DB_FILE)
  if (fileState(path) !== 'new') return dbKeyActions(env)
  const store = keyStoreOf(env)
  if (store === null) return dbKeyActions(env)
  if (encryption.kind === 'new-plain') {
    env.out('database: the new store is created plaintext (--no-encrypt)')
    return [{ kind: 'create-plain-store', path }]
  }
  const stored = storedDbKey(env)
  if (encryption.key === null) {
    if (stored.kind === 'unreadable') throw new ChoiceError(staleDbKey(store))
    if (stored.kind === 'usable') {
      env.out(foundLine(store))
      return []
    }
    env.out(newKeyLine(store))
    return [{ kind: 'create-db-key', path }]
  }
  if (stored.kind === 'usable' && stored.key === encryption.key) {
    env.out(foundLine(store))
    return []
  }
  env.out('database: the new store is created encrypted with the key whose recovery code you confirmed')
  return [{ kind: 'create-db-key', path, key: encryption.key }]
}

export function describeCreateDbKey(path: string, key?: string): string {
  if (key !== undefined) return `keychain: create ${DB_KEY_REF} (<hidden>, the key whose recovery code was shown) for the new store ${path}; stops if another entry is there`
  return `keychain: create ${DB_KEY_REF} (32 random bytes, never shown) for the new store ${path}, unless an entry exists already`
}

/**
 * Run time, not plan time: the store must still be new (downloads ran in
 * between), and the add never replaces an entry, so a key that some store
 * already uses is never lost. A given key is one whose recovery code was
 * shown; an entry already there under another key makes that code useless,
 * so the step fails before the daemon can create the store under it.
 */
export function createDbKey(env: InstallEnv, path: string, key?: string): void {
  if (fileState(path) !== 'new') {
    env.out(`database: ${path} appeared while install ran; no key was created`)
    return
  }
  const store = keyStoreOf(env)
  if (store === null) throw new Error(`no key store on ${env.platform}`)
  if (key === undefined) {
    if (!store.create(DB_KEY_REF, newDbKey())) env.out(`database: ${store.label} entry ${DB_KEY_REF} exists already; kept it`)
    return
  }
  if (store.create(DB_KEY_REF, key)) return
  const stored = storedDbKey(env)
  if (stored.kind !== 'usable' || stored.key !== key) throw new Error(dbKeyMismatch(store))
}

export function describeCreatePlainStore(path: string): string {
  return `create ${path} as a plaintext store (mode 0600), so the daemon does not create it encrypted`
}

/** Run time: only while the store is still missing; one that appeared meanwhile is left as it is. */
export function createPlainStore(env: InstallEnv, path: string): void {
  if (fileState(path) !== 'new') {
    env.out(`database: ${path} appeared while install ran; left as it is`)
    return
  }
  openStore(dirname(path), { keys: NO_DB_KEYS }).db.close()
}

function keyPresence(store: KeyStore | null): string {
  if (store === null) return 'no key store'
  try {
    return store.exists(DB_KEY_REF) ? `${store.label} ${DB_KEY_REF} present` : `${store.label} ${DB_KEY_REF} missing`
  } catch (error: unknown) {
    return `${store.label} ${DB_KEY_REF} unknown (${errorMessage(error)})`
  }
}

async function diskEncryptionLine(env: InstallEnv): Promise<string | null> {
  if (platformOf(env).os !== 'macos') return null
  const result = await env.run({ argv: [FDESETUP, 'status'], timeoutMs: 5_000 })
  if (result.exitCode !== 0) return `disk encryption: could not check (fdesetup exit ${result.exitCode})`
  if (result.stdout.includes('FileVault is On')) return 'disk encryption: FileVault on'
  if (result.stdout.includes('FileVault is Off')) {
    return 'warning: FileVault is off; the spool, logs and agent transcripts are unencrypted on disk. Turn it on in System Settings > Privacy & Security'
  }
  return 'disk encryption: FileVault state unknown'
}

/**
 * `kinfold status`: how memory.db is stored, whether its key entry exists (metadata only), and the disk encryption state.
 * The first line is the `database:` line. An untrusted key-store.json is reported, never thrown.
 */
export async function dbStatusLines(env: InstallEnv): Promise<string[]> {
  const path = join(env.dataDir, DB_FILE)
  const state = fileState(path)
  const read = readKeyStore(env)
  const store = read.ok ? read.store : null
  const keys = read.ok ? keyPresence(store) : 'key store unknown'
  const database = state === 'new'
    ? `database: not created yet (${keys})`
    : state === 'plain'
      ? `database: plaintext; kinfold encrypt converts it (${keys})`
      : `database: encrypted (${keys})`
  const lines = [database]
  if (store !== null && state === 'plain' && keys.endsWith('present')) {
    lines.push(`warning: memory.db is plaintext but ${store.place} holds ${DB_KEY_REF}; the file was replaced by a plaintext copy, or a conversion failed`)
  }
  if (existsSync(maintenancePath(path))) {
    lines.push(`warning: ${maintenancePath(path)} is there: a kinfold encrypt, decrypt or rekey is running or was cut short; nothing opens memory.db until it goes. If none is running, run kinfold key resume`)
  }
  if (existsSync(foundBackupPath(path))) {
    lines.push(`warning: ${foundBackupPath(path)} is left from a conversion that was cut short; it is the original store; run kinfold key resume`)
  }
  try {
    if (store?.exists(DB_KEY_NEXT_REF) === true) lines.push(`warning: ${store.place} holds ${DB_KEY_NEXT_REF}: a kinfold rekey was cut short; run kinfold key resume`)
  } catch {
    // keyPresence already reported a failing lookup.
  }
  if (store !== null && state === 'encrypted' && keys.endsWith('missing')) {
    // The Keychain names its service, since an entry under the old one does not count here.
    const service = store.kind === 'keychain' ? ` under ${KEYCHAIN_SERVICE}` : ''
    lines.push(`warning: memory.db is encrypted and ${store.place} has no ${DB_KEY_REF}${service}; restore it with kinfold key recover`)
  }
  const disk = await diskEncryptionLine(env)
  return disk === null ? lines : [...lines, disk]
}
