// key-store.json in the data folder names the store install chose, so every
// later process (daemon, hooks, MCP server, CLI) opens that same store and
// never probes for one. Probing at run time could pick a different store than
// the one holding the key and then make a fresh key there; a record that
// cannot be trusted stops the process instead.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { readEnv } from '../env-names'
import { type PlatformInfo, currentPlatform } from '../platform/platform'
import { KEY_STORE_KINDS, type KeyStore, type KeyStoreDeps, type KeyStoreKind, type KeyStoreModule } from './key-store'
import { createSecurityRunner } from './stores/keychain'
import { KEY_STORE_MODULES, candidateKeyStores, openKeyStore } from './stores/select'

type Env = Readonly<Record<string, string | undefined>>
type ModuleTable = Readonly<Record<KeyStoreKind, KeyStoreModule>>

export const KEY_STORE_FILE = 'key-store.json'

export interface KeyStoreRecord {
  store: KeyStoreKind
  chosenAt: number
  /** Where the store keeps its keys when that depends on the env at install (the key-file folder). */
  location?: string
}

export type KeyStoreRecordRead =
  | { state: 'present'; record: KeyStoreRecord }
  | { state: 'missing' }
  | { state: 'unreadable' }

const RECORD_KEYS: ReadonlySet<string> = new Set(['store', 'chosenAt', 'location'])

function isKind(value: unknown): value is KeyStoreKind {
  return typeof value === 'string' && (KEY_STORE_KINDS as readonly string[]).includes(value)
}

// Strict on purpose: a record that was hand-edited or half-written must not be
// read as some store, since the wrong store would look empty and invite a new key.
function parseRecord(text: string): KeyStoreRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).some((key) => !RECORD_KEYS.has(key))) return null
  const { store, chosenAt, location } = fields
  if (!isKind(store)) return null
  if (typeof chosenAt !== 'number' || !Number.isSafeInteger(chosenAt) || chosenAt <= 0) return null
  if (location === undefined) return { store, chosenAt }
  if (typeof location !== 'string' || !isAbsolute(location) || location.includes('\0')) return null
  return { store, chosenAt, location }
}

export function keyStoreRecordPath(dataDir: string): string {
  return join(dataDir, KEY_STORE_FILE)
}

export function readKeyStoreRecord(dataDir: string): KeyStoreRecordRead {
  let text: string
  try {
    text = readFileSync(keyStoreRecordPath(dataDir), 'utf8')
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' }
  }
  const record = parseRecord(text)
  return record === null ? { state: 'unreadable' } : { state: 'present', record }
}

export function keyStoreRecordContent(record: KeyStoreRecord): string {
  const fields: KeyStoreRecord = record.location === undefined
    ? { store: record.store, chosenAt: record.chosenAt }
    : { store: record.store, chosenAt: record.chosenAt, location: record.location }
  return `${JSON.stringify(fields, null, 2)}\n`
}

export function recordUnreadableMessage(path: string): string {
  return `${path} cannot be read, so the key store chosen at install is unknown. Nothing was changed and no new key was made. Restore the file; delete it and run kinfold install only if no key was ever stored`
}

export function recordMismatchMessage(path: string, kind: KeyStoreKind, platform: PlatformInfo): string {
  return `${path} names the ${KEY_STORE_MODULES[kind].label}, which is not a key store on ${platform.os}. Nothing was changed and no new key was made`
}

/** KINFOLD_DB_KEYSTORE=none counts only under bun test, so no production env can switch encryption off. */
export function keyStoresOffForTests(env: Env): boolean {
  return readEnv(env, 'DB_KEYSTORE') === 'none' && env.NODE_ENV === 'test'
}

/** Never probes. present: that store. missing: the Keychain on macOS (installs before the record), else null. unreadable or mismatched: throws. */
export function resolveKeyStore(dataDir: string, deps: KeyStoreDeps, modules: ModuleTable = KEY_STORE_MODULES): KeyStore | null {
  if (keyStoresOffForTests(deps.envVars)) return null
  const path = keyStoreRecordPath(dataDir)
  const read = readKeyStoreRecord(dataDir)
  if (read.state === 'unreadable') throw new Error(recordUnreadableMessage(path))
  if (read.state === 'missing') {
    // Every macOS install before the record existed kept its keys in the Keychain.
    return deps.platform.os === 'macos' ? openKeyStore('keychain', { ...deps, dataDir }, modules) : null
  }
  const { record } = read
  if (!candidateKeyStores(deps.platform).includes(record.store)) throw new Error(recordMismatchMessage(path, record.store, deps.platform))
  return openKeyStore(record.store, { ...deps, dataDir, location: record.location }, modules)
}

/** The real process's deps: currentPlatform(), HOME, this data folder, the env, the real security runner. */
export function processKeyStoreDeps(dataDir: string, env: Env = process.env): KeyStoreDeps {
  const homeDir = env.HOME !== undefined && env.HOME !== '' ? env.HOME : homedir()
  return { platform: currentPlatform(), homeDir, dataDir, envVars: env, security: createSecurityRunner(homeDir) }
}
