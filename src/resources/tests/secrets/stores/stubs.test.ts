import { expect, test } from 'bun:test'
import { KEY_STORE_KINDS, type KeyStoreDeps } from '../key-store'
import { KEY_STORE_MODULES } from './select'
import { stubKeyStoreModule } from './stub'

const deps: KeyStoreDeps = {
  platform: { os: 'linux', wsl: false, node: 'linux' },
  homeDir: '/home/test',
  dataDir: '/home/test/.kinfold',
  envVars: {},
  security: () => {
    throw new Error('a stub store must never run security')
  },
}

test('a stub store refuses with the fixed message', () => {
  const module = stubKeyStoreModule('libsecret', 'Test Store', 'the test store')
  expect(module.probe(deps)).toEqual({ usable: false, reason: 'not supported on this platform yet' })
  expect(module.location).toBeUndefined()
  const store = module.open(deps)
  expect(() => store.get('db-key')).toThrow(new Error('Test Store: not supported on this platform yet'))
  for (const action of [() => store.exists('db-key'), () => store.set('db-key', 'value'), () => store.create('db-key', 'value'), () => store.delete('db-key')]) {
    expect(action).toThrow(new Error('Test Store: not supported on this platform yet'))
  }
  expect([store.describeSet('db-key'), store.describeDelete('db-key'), store.describeEntry('db-key')]).toEqual(Array(3).fill('Test Store: not supported on this platform yet'))
  expect([store.kind, store.label, store.place, store.notes]).toEqual(['libsecret', 'Test Store', 'the test store', []])
})

test('every kind has a module with its label', () => {
  const labels = { keychain: 'keychain', libsecret: 'libsecret', 'key-file': 'key file', 'credential-manager': 'Credential Manager' }
  expect([...KEY_STORE_KINDS].sort() as string[]).toEqual(Object.keys(labels).sort())
  for (const kind of KEY_STORE_KINDS) {
    expect(KEY_STORE_MODULES[kind].kind).toBe(kind)
    expect(KEY_STORE_MODULES[kind].label).toBe(labels[kind])
  }
})
