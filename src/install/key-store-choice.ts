// Which key store the installer and the key commands use. Every step of one
// install run reads and writes the same store: install picks it once, before
// the questions, and carries it in env.keyStore. Other commands open the store
// key-store.json names, never probing, so they cannot pick a different store
// than the one holding the keys.

import type { OsName } from '../platform/platform'
import type { KeyStore, KeyStoreDeps, KeyStoreKind, KeyStoreModule } from '../secrets/key-store'
import {
  type KeyStoreRecord,
  keyStoreRecordPath,
  keyStoresOffForTests,
  readKeyStoreRecord,
  recordMismatchMessage,
  recordUnreadableMessage,
  resolveKeyStore,
} from '../secrets/key-store-record'
import { KEY_STORE_MODULES, candidateKeyStores, chooseKeyStore, openKeyStore } from '../secrets/stores/select'
import { type InstallEnv, errorMessage, platformOf } from './env'
import type { Action } from './plan'

type ModuleTable = Readonly<Record<KeyStoreKind, KeyStoreModule>>

export function keyStoreDepsOf(env: InstallEnv): KeyStoreDeps {
  return { platform: platformOf(env), homeDir: env.homeDir, dataDir: env.dataDir, envVars: env.envVars ?? {}, security: env.security }
}

/** The injected store, else resolveKeyStore for env.dataDir. */
export function keyStoreOf(env: InstallEnv): KeyStore | null {
  if (env.keyStore !== undefined) return env.keyStore
  return resolveKeyStore(env.dataDir, keyStoreDepsOf(env))
}

export type InstallKeyStore =
  | { kind: 'recorded'; store: KeyStore }
  | { kind: 'chosen'; store: KeyStore }
  | { kind: 'none'; os: OsName; store: null }

function noStore(env: InstallEnv): InstallKeyStore {
  return { kind: 'none', os: platformOf(env).os, store: null }
}

/** The location a module asks to record, or undefined when it records none. */
function locationOf(module: KeyStoreModule, deps: KeyStoreDeps): string | undefined {
  return module.location?.(deps) ?? undefined
}

/** install only: the recorded store, else the first usable candidate. Throws the record's fixed messages. */
export function chooseInstallKeyStore(env: InstallEnv, modules: ModuleTable = KEY_STORE_MODULES): InstallKeyStore {
  const deps = keyStoreDepsOf(env)
  if (keyStoresOffForTests(deps.envVars)) return noStore(env)
  const path = keyStoreRecordPath(env.dataDir)
  const read = readKeyStoreRecord(env.dataDir)
  // An untrusted record stops install before anything is written, injected store or not.
  if (read.state === 'unreadable') throw new Error(recordUnreadableMessage(path))
  if (env.keyStore !== undefined) {
    if (env.keyStore === null) return noStore(env)
    return { kind: read.state === 'present' ? 'recorded' : 'chosen', store: env.keyStore }
  }
  if (read.state === 'present') {
    const { record } = read
    if (!candidateKeyStores(deps.platform).includes(record.store)) throw new Error(recordMismatchMessage(path, record.store, deps.platform))
    return { kind: 'recorded', store: openKeyStore(record.store, { ...deps, location: record.location }, modules) }
  }
  const kind = chooseKeyStore(deps, modules)
  if (kind === null) return noStore(env)
  return { kind: 'chosen', store: openKeyStore(kind, { ...deps, location: locationOf(modules[kind], deps) }, modules) }
}

/** One record-key-store for 'chosen', carrying module.location?.(deps) when that is non-null; else []. */
export function keyStoreRecordActions(env: InstallEnv, choice: InstallKeyStore, modules: ModuleTable = KEY_STORE_MODULES): Action[] {
  if (choice.kind !== 'chosen') return []
  const location = locationOf(modules[choice.store.kind], keyStoreDepsOf(env))
  const record: KeyStoreRecord = location === undefined
    ? { store: choice.store.kind, chosenAt: env.now() }
    : { store: choice.store.kind, chosenAt: env.now(), location }
  return [{ kind: 'record-key-store', path: keyStoreRecordPath(env.dataDir), record }]
}

/** `kinfold status`: which store holds the keys and whether key-store.json names it. Never throws. */
export function keyStoreStatusLine(env: InstallEnv): string {
  try {
    const read = readKeyStoreRecord(env.dataDir)
    if (read.state === 'unreadable') return `key store: unknown (${recordUnreadableMessage(keyStoreRecordPath(env.dataDir))})`
    const store = keyStoreOf(env)
    if (store === null) return `key store: none on ${platformOf(env).os}; new stores are created plaintext`
    if (read.state === 'present') return `key store: ${store.label} (recorded in key-store.json)`
    return `key store: ${store.label} (not recorded yet; the next install records it)`
  } catch (error: unknown) {
    return `key store: unknown (${errorMessage(error)})`
  }
}

/** The store, or the fixed reason it cannot be opened, for callers that must go on without it. */
export type KeyStoreRead = { ok: true; store: KeyStore | null } | { ok: false; reason: string }

export function readKeyStore(env: InstallEnv): KeyStoreRead {
  try {
    return { ok: true, store: keyStoreOf(env) }
  } catch (error: unknown) {
    return { ok: false, reason: errorMessage(error) }
  }
}

/** Plan-time description, so a dry run prints what the store itself would do. */
export function secretSetAction(store: KeyStore, ref: string, value: string): Action {
  return { kind: 'secret-set', ref, value, description: store.describeSet(ref) }
}

export function secretDeleteAction(store: KeyStore, ref: string, summary?: string): Action {
  return summary === undefined
    ? { kind: 'secret-delete', ref, description: store.describeDelete(ref) }
    : { kind: 'secret-delete', ref, description: store.describeDelete(ref), summary }
}

/** applyAction's store; with none, credentials cannot be stored here. */
export function requireKeyStore(env: InstallEnv): KeyStore {
  const store = keyStoreOf(env)
  if (store === null) throw new Error(`no key store on ${env.platform}; credentials are not stored`)
  return store
}

/** "the Keychain" -> "The Keychain", for a store's place at the start of a sentence. */
export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
