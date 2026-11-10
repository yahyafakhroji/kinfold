import { expect, test } from 'bun:test'
import type { KeyStoreDeps } from '../key-store'
import { runKeyStoreContract } from './contract'
import {
  type BindingLoader,
  type SecretCollectionState,
  type SecretLookup,
  type SecretServiceBinding,
  SecretServiceError,
  createLibsecretModule,
  createLibsecretStore,
  libsecretModule,
  probeLibsecret,
} from './libsecret'

const VALUE = 'libsecret-value-0123456789abcdef'
const BUS = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' }
const UNREACHABLE = 'libsecret: the Secret Service keyring chosen at install cannot be reached (no D-Bus session bus); nothing was read or written'
const LOCKED = 'libsecret: the keyring is locked; unlock it and run the command again. Nothing was read or written'
const UNLOADABLE = 'libsecret: libsecret-1.so.0 cannot be loaded; nothing was read or written'

/** An in-memory Secret Service; records one line per call, never a value, and counts loads. */
function fakeSecretService(options: { collection?: SecretCollectionState; lockedAccounts?: readonly string[] } = {}) {
  const values = new Map<string, string>()
  const locked = new Set(options.lockedAccounts ?? [])
  for (const account of locked) values.set(account, 'locked-value')
  const calls: string[] = []
  let loads = 0
  const binding: SecretServiceBinding = {
    defaultCollection: () => options.collection ?? 'unlocked',
    exists: (account) => (calls.push(`exists ${account}`), values.has(account)),
    lookup: (account): SecretLookup => {
      calls.push(`lookup ${account}`)
      if (!values.has(account)) return { found: false }
      if (locked.has(account)) return { found: true, locked: true }
      return { found: true, locked: false, value: values.get(account) ?? null }
    },
    // A locked item is refused before anything is written, as the real binding does.
    store: (account, _label, value) => {
      if (locked.has(account)) throw new SecretServiceError('store', 'locked')
      calls.push(`store ${account}`)
      values.set(account, value)
    },
    remove: (account) => (calls.push(`remove ${account}`), values.delete(account)),
  }
  const load: BindingLoader = () => (loads++, binding)
  return { load, loads: () => loads, calls, values }
}

function linuxDeps(envVars: Record<string, string | undefined> = BUS, extra: Partial<KeyStoreDeps> = {}): KeyStoreDeps {
  return {
    platform: { os: 'linux', wsl: false, node: 'linux' },
    homeDir: '/home/test',
    dataDir: '/home/test/.kinfold',
    envVars,
    security: () => {
      throw new Error('a libsecret store must never run security')
    },
    ...extra,
  }
}

function failingBinding(): SecretServiceBinding {
  const fail = (operation: 'connect' | 'search' | 'lookup' | 'store' | 'delete') => (): never => {
    throw new SecretServiceError(operation, 2)
  }
  return { defaultCollection: fail('connect'), exists: fail('search'), lookup: fail('lookup'), store: fail('store'), remove: fail('delete') }
}

function messageOf(action: () => unknown): string {
  try {
    action()
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a failure')
}

runKeyStoreContract('libsecret', () => {
  const fake = fakeSecretService()
  const failing = failingBinding()
  return {
    store: createLibsecretStore(linuxDeps(), fake.load),
    observed: () => fake.calls,
    failing: () => createLibsecretStore(linuxDeps(), () => failing),
  }
})

test('a store with no session bus never loads libsecret', () => {
  for (const envVars of [{}, { DBUS_SESSION_BUS_ADDRESS: '' }]) {
    const fake = fakeSecretService()
    const store = createLibsecretStore(linuxDeps(envVars), fake.load)
    const actions = [
      () => store.get('db-key'),
      () => store.exists('db-key'),
      () => store.set('db-key', VALUE),
      () => store.create('db-key', VALUE),
      () => store.delete('db-key'),
    ]
    for (const action of actions) expect(messageOf(action)).toBe(UNREACHABLE)
    expect(fake.loads()).toBe(0)
  }
})

test('a locked item is refused, never unlocked', () => {
  const fake = fakeSecretService({ lockedAccounts: ['hmac-master'] })
  const store = createLibsecretStore(linuxDeps(), fake.load)
  expect(messageOf(() => store.get('hmac-master'))).toBe(LOCKED)
  expect(messageOf(() => store.set('hmac-master', VALUE))).toBe(LOCKED)
  expect(fake.calls.filter((call) => call.startsWith('store '))).toEqual([])
})

test('create never replaces', () => {
  const fake = fakeSecretService()
  fake.values.set('db-key', VALUE)
  const store = createLibsecretStore(linuxDeps(), fake.load)
  expect(store.create('db-key', 'another-value-0123')).toBe(false)
  expect(fake.calls).toContain('exists db-key')
  expect(fake.calls.filter((call) => call.startsWith('store '))).toEqual([])
  expect(fake.values.get('db-key')).toBe(VALUE)
})

test('a binding error becomes a fixed message', () => {
  const store = createLibsecretStore(linuxDeps(), () => failingBinding())
  expect(messageOf(() => store.get('db-key'))).toBe('libsecret: lookup failed (code 2)')
  expect(messageOf(() => store.delete('db-key'))).toBe('libsecret: delete failed (code 2)')
  const unloadable = createLibsecretStore(linuxDeps(), () => {
    throw new SecretServiceError('connect', 'unloadable')
  })
  expect(messageOf(() => unloadable.get('db-key'))).toBe(UNLOADABLE)
})

test('the probe follows the default keyring', () => {
  const unloadable: BindingLoader = () => {
    throw new SecretServiceError('connect', 'unloadable')
  }
  const cases: [KeyStoreDeps, BindingLoader, string][] = [
    [linuxDeps(BUS, { platform: { os: 'macos', wsl: false, node: 'darwin' } }), fakeSecretService().load, 'not Linux'],
    [linuxDeps({}), fakeSecretService().load, 'no D-Bus session bus'],
    [linuxDeps(), unloadable, 'libsecret-1.so.0 is not installed'],
    [linuxDeps(), fakeSecretService({ collection: 'missing' }).load, 'no default keyring'],
    [linuxDeps(), fakeSecretService({ collection: 'locked' }).load, 'the default keyring is locked'],
    [linuxDeps(), () => failingBinding(), 'the Secret Service did not answer'],
  ]
  for (const [deps, load, reason] of cases) expect(probeLibsecret(deps, load)).toEqual({ usable: false, reason })
  const noBus = fakeSecretService()
  probeLibsecret(linuxDeps({}), noBus.load)
  expect(noBus.loads()).toBe(0)
  expect(probeLibsecret(linuxDeps(), fakeSecretService().load)).toEqual({ usable: true })
  expect(createLibsecretModule(fakeSecretService().load).probe(linuxDeps())).toEqual({ usable: true })
})

test('libsecret describe texts hide the value', () => {
  const store = createLibsecretStore(linuxDeps(), fakeSecretService().load)
  expect(store.describeSet('db-key')).toBe('libsecret: store the secret for db-key in the default keyring (schema dev.kinfold.Secret, label "Kinfold db-key", value <hidden>)')
  expect(store.describeDelete('db-key')).toBe('libsecret: delete the keyring item with schema dev.kinfold.Secret and account db-key')
  expect(store.describeEntry('db-key')).toBe('the keyring item "Kinfold db-key" (schema dev.kinfold.Secret, account db-key)')
})

test('the module names the keyring and records no location', () => {
  expect([libsecretModule.kind, libsecretModule.label, libsecretModule.location]).toEqual(['libsecret', 'libsecret', undefined])
  const store = libsecretModule.open(linuxDeps({}))
  expect([store.kind, store.label, store.place, store.notes]).toEqual(['libsecret', 'libsecret', 'the Secret Service keyring', []])
})
