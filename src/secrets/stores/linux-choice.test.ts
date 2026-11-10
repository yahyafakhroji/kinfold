// The two Linux stores through key-store.json: install picks the keyring when
// it is unlocked, else the key file, and every later process opens what was
// recorded, never the other one.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly } from '../../../test/platform-guards'
import { EXIT_OK, install } from '../../install/install'
import { keyStoreStatusLine } from '../../install/key-store-choice'
import { type FakeWorld, YES, createWorld } from '../../install/test-support'
import { dbKeyStoreFor } from '../../sqlite/keys'
import type { KeyStoreDeps, KeyStoreKind, KeyStoreModule } from '../key-store'
import { KEY_STORE_FILE, keyStoreRecordContent, resolveKeyStore } from '../key-store-record'
import { KEY_FILE_NOTES, keyFileDir, keyFileModule } from './key-file'
import { type BindingLoader, type SecretCollectionState, type SecretServiceBinding, createLibsecretModule } from './libsecret'
import { KEY_STORE_MODULES, chooseKeyStore } from './select'

type ModuleTable = Readonly<Record<KeyStoreKind, KeyStoreModule>>

const BUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
const UNREACHABLE = 'libsecret: the Secret Service keyring chosen at install cannot be reached (no D-Bus session bus); nothing was read or written'
const KEY = 'ab'.repeat(32)
const CHOSEN_AT = 1_792_900_000_000

const roots: string[] = []
let world: FakeWorld | null = null

afterEach(async () => {
  await world?.cleanup()
  world = null
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-linux-choice-'))
  roots.push(root)
  return root
}

/** A keyring in memory with the default collection in `state`; counts loads. */
function fakeKeyring(state: SecretCollectionState) {
  const values = new Map<string, string>()
  let loads = 0
  const binding: SecretServiceBinding = {
    defaultCollection: () => state,
    exists: (account) => values.has(account),
    lookup: (account) => (values.has(account) ? { found: true, locked: false, value: values.get(account) ?? null } : { found: false }),
    store: (account, _label, value) => void values.set(account, value),
    remove: (account) => values.delete(account),
  }
  const load: BindingLoader = () => (loads++, binding)
  return { load, loads: () => loads }
}

function modulesWith(load: BindingLoader): ModuleTable {
  return { ...KEY_STORE_MODULES, libsecret: createLibsecretModule(load), 'key-file': keyFileModule }
}

function depsAt(root: string, envVars: Record<string, string | undefined>): KeyStoreDeps {
  const homeDir = join(root, 'home')
  return {
    platform: { os: 'linux', wsl: false, node: 'linux' },
    homeDir,
    dataDir: join(homeDir, '.kinfold'),
    envVars,
    security: () => {
      throw new Error('a Linux store must never run security')
    },
  }
}

function writeRecord(dataDir: string, store: KeyStoreKind, location?: string): void {
  mkdirSync(dataDir, { recursive: true })
  const record = location === undefined ? { store, chosenAt: CHOSEN_AT } : { store, chosenAt: CHOSEN_AT, location }
  writeFileSync(join(dataDir, KEY_STORE_FILE), keyStoreRecordContent(record))
}

test('an unlocked keyring is chosen first', () => {
  const keyring = fakeKeyring('unlocked')
  expect(chooseKeyStore(depsAt(tempRoot(), BUS), modulesWith(keyring.load))).toBe('libsecret')
})

posixOnly('file modes')('no session bus or a locked keyring means the key file', () => {
  const noBus = fakeKeyring('unlocked')
  expect(chooseKeyStore(depsAt(tempRoot(), {}), modulesWith(noBus.load))).toBe('key-file')
  expect(noBus.loads()).toBe(0)
  const locked = fakeKeyring('locked')
  expect(chooseKeyStore(depsAt(tempRoot(), BUS), modulesWith(locked.load))).toBe('key-file')
})

test('a recorded keyring is never swapped for a key file', () => {
  const deps = depsAt(tempRoot(), {})
  writeRecord(deps.dataDir, 'libsecret')
  const store = resolveKeyStore(deps.dataDir, deps)
  expect(store?.kind).toBe('libsecret')
  expect(() => store?.get('db-key')).toThrow(UNREACHABLE)
  expect(() => dbKeyStoreFor(deps.dataDir, {}, deps).exists()).toThrow(UNREACHABLE)
  expect(existsSync(keyFileDir(deps))).toBe(false)
})

test('a recorded key file is used when a keyring appears later', () => {
  const keyring = fakeKeyring('unlocked')
  const deps = depsAt(tempRoot(), BUS)
  writeRecord(deps.dataDir, 'key-file', keyFileDir(deps))
  expect(resolveKeyStore(deps.dataDir, deps, modulesWith(keyring.load))?.kind).toBe('key-file')
  expect(keyring.loads()).toBe(0)
})

posixOnly('file modes')('a later process with another XDG_CONFIG_HOME reads the recorded folder', () => {
  const root = tempRoot()
  const atInstall = depsAt(root, { XDG_CONFIG_HOME: join(root, 'a') })
  const location = keyFileModule.location?.(atInstall) ?? undefined
  expect(location).toBe(join(root, 'a', 'kinfold'))
  writeRecord(atInstall.dataDir, 'key-file', location)
  resolveKeyStore(atInstall.dataDir, atInstall)?.set('db-key', KEY)

  const later = depsAt(root, { XDG_CONFIG_HOME: join(root, 'b') })
  expect(resolveKeyStore(later.dataDir, later)?.get('db-key')).toBe(KEY)
  expect(existsSync(join(root, 'b', 'kinfold'))).toBe(false)
})

test('status names the Linux store', () => {
  const w = createWorld({ platform: 'linux' })
  world = w
  const env = { ...w.env, envVars: { XDG_CONFIG_HOME: join(w.root, 'config') } }
  writeRecord(w.dataDir, 'key-file', join(w.root, 'config', 'kinfold'))
  expect(keyStoreStatusLine(env)).toBe('key store: key file (recorded in key-store.json)')
  writeRecord(w.dataDir, 'libsecret')
  expect(keyStoreStatusLine(env)).toBe('key store: libsecret (recorded in key-store.json)')
})

posixOnly('file modes')('a Linux install records the key file and keeps encryption on', async () => {
  const w = createWorld({ platform: 'linux' })
  world = w
  const env = { ...w.env, envVars: { XDG_CONFIG_HOME: join(w.root, 'config') } }
  expect(await install(env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  const record = `record the key store (key file) in ${join(w.dataDir, KEY_STORE_FILE)} (mode 0600)`
  expect(w.out.some((line) => line.includes(record))).toBe(true)
  for (const note of KEY_FILE_NOTES) expect(w.out.filter((line) => line.includes(note))).toHaveLength(1)
  expect(w.out.some((line) => line.includes('created plaintext'))).toBe(false)
})
