import { expect, test } from 'bun:test'
import type { PlatformInfo } from '../../platform/platform'
import { NO_DB_KEYS, dbKeyStoreOf } from '../../sqlite/keys'
import { type KeyStoreDeps, type KeyStoreKind, type KeyStoreModule, credentialProviderOf } from '../key-store'
import { KEY_STORE_MODULES, candidateKeyStores, chooseKeyStore, openKeyStore, probeKeyStores } from './select'

const MAC: PlatformInfo = { os: 'macos', wsl: false, node: 'darwin' }
const LINUX: PlatformInfo = { os: 'linux', wsl: false, node: 'linux' }
const WSL: PlatformInfo = { os: 'linux', wsl: true, node: 'linux' }
const WINDOWS: PlatformInfo = { os: 'windows', wsl: false, node: 'win32' }

function depsOn(platform: PlatformInfo): KeyStoreDeps {
  return {
    platform,
    homeDir: '/home/test',
    dataDir: '/home/test/.kinfold',
    envVars: {},
    security: () => {
      throw new Error('selection must never run security')
    },
  }
}

function withUsable(usable: Partial<Record<KeyStoreKind, boolean>>): Readonly<Record<KeyStoreKind, KeyStoreModule>> {
  const entries = Object.entries(KEY_STORE_MODULES).map(([kind, module]) => [kind, {
    ...module,
    probe: () => (usable[kind as KeyStoreKind] === true ? { usable: true } : { usable: false, reason: 'test says no' }),
  }])
  return Object.fromEntries(entries) as Record<KeyStoreKind, KeyStoreModule>
}

test('candidates follow the platform', () => {
  expect(candidateKeyStores(MAC)).toEqual(['keychain'])
  expect(candidateKeyStores(LINUX)).toEqual(['libsecret', 'key-file'])
  expect(candidateKeyStores(WSL)).toEqual(['libsecret', 'key-file'])
  expect(candidateKeyStores(WINDOWS)).toEqual(['credential-manager'])
})

test('the first usable candidate is chosen', () => {
  expect(chooseKeyStore(depsOn(LINUX), withUsable({ 'key-file': true }))).toBe('key-file')
  expect(chooseKeyStore(depsOn(LINUX), withUsable({ libsecret: true, 'key-file': true }))).toBe('libsecret')
  expect(chooseKeyStore(depsOn(LINUX), withUsable({}))).toBeNull()
  expect(chooseKeyStore(depsOn(MAC), withUsable({ keychain: true, libsecret: true }))).toBe('keychain')
})

test('with no usable candidate every refusal is kept, in order, with its label', () => {
  expect(probeKeyStores(depsOn(LINUX), withUsable({}))).toEqual({
    refused: [
      { label: KEY_STORE_MODULES.libsecret.label, reason: 'test says no' },
      { label: KEY_STORE_MODULES['key-file'].label, reason: 'test says no' },
    ],
  })
  expect(probeKeyStores(depsOn(LINUX), withUsable({ 'key-file': true }))).toEqual({ store: 'key-file' })
})

test('a store from another platform is refused', () => {
  expect(() => openKeyStore('credential-manager', depsOn(MAC))).toThrow(new Error('the Credential Manager is not a key store on macos'))
  expect(openKeyStore('keychain', depsOn(MAC)).kind).toBe('keychain')
})

test('no store means no credentials and no database key', () => {
  expect(credentialProviderOf(null).get('openrouter')).toBeNull()
  expect(dbKeyStoreOf(null)).toBe(NO_DB_KEYS)
})
