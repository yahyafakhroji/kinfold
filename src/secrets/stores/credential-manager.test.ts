import { afterEach, expect, test } from 'bun:test'
import { ptr } from 'bun:ffi'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXIT_OK, install } from '../../install/install'
import { refusalLines } from '../../install/key-store-choice'
import { type FakeWorld, YES, createWorld, forbiddenSecurity } from '../../install/test-support'
import { dbKeyStoreOf } from '../../sqlite/keys'
import { openStoreFile } from '../../sqlite/open'
import { SqliteError } from '../../sqlite/types'
import { readMaster } from '../hmac-keys'
import { type KeyStoreDeps, type KeyStoreKind, type KeyStoreModule, credentialProviderOf } from '../key-store'
import { KEY_STORE_FILE, resolveKeyStore } from '../key-store-record'
import { runKeyStoreContract } from './contract'
import {
  CREDENTIALW_OFFSETS,
  CREDENTIALW_SIZE,
  CRED_MAX_BLOB_BYTES,
  CRED_PERSIST_LOCAL_MACHINE,
  CRED_TYPE_GENERIC,
  type CredApi,
  type CredResult,
  ERROR_NOT_FOUND,
  ERROR_NO_SUCH_LOGON_SESSION,
  createCredentialManagerModule,
  createCredentialManagerStore,
  credentialManagerModule,
  credentialTarget,
  packCredential,
} from './credential-manager'
import { KEY_STORE_MODULES, probeKeyStores } from './select'

type ModuleTable = Readonly<Record<KeyStoreKind, KeyStoreModule>>

interface FakeCredApi extends CredApi {
  /** One `op target` line per call; never a blob. */
  log: string[]
  /** What each write handed CredWriteW, read back from the packed CREDENTIALW. */
  written: { type: number; persist: number; userName: string; blobSize: number }[]
}

const decodeWide = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf16le').replace(/\0$/, '')

/** An in-memory Credential Manager; `failWith` answers every call with that error instead. */
function fakeCredApi(failWith: number | null = null, log: string[] = []): FakeCredApi {
  const entries = new Map<string, Uint8Array>()
  const written: FakeCredApi['written'] = []
  const fail = <T>(): CredResult<T> => ({ ok: false, error: failWith ?? 0 })
  return {
    log,
    written,
    read: (target) => {
      log.push(`read ${target}`)
      if (failWith !== null) return fail()
      const blob = entries.get(target)
      return blob === undefined ? { ok: false, error: ERROR_NOT_FOUND } : { ok: true, value: blob.slice() }
    },
    peek: (target) => {
      log.push(`peek ${target}`)
      if (failWith !== null) return fail()
      return entries.has(target) ? { ok: true, value: true } : { ok: false, error: ERROR_NOT_FOUND }
    },
    write: (target, blob) => {
      log.push(`write ${target}`)
      if (failWith !== null) return fail()
      const packed = packCredential(target, blob)
      const view = new DataView(packed.struct.buffer)
      written.push({
        type: view.getUint32(CREDENTIALW_OFFSETS.type, true),
        persist: view.getUint32(CREDENTIALW_OFFSETS.persist, true),
        userName: view.getBigUint64(CREDENTIALW_OFFSETS.userName, true) === BigInt(ptr(packed.userName)) ? decodeWide(packed.userName) : '<bad pointer>',
        blobSize: view.getUint32(CREDENTIALW_OFFSETS.credentialBlobSize, true),
      })
      // The store zeroes its buffer after the call, so the fake keeps a copy.
      entries.set(target, blob.slice())
      return { ok: true, value: true }
    },
    remove: (target) => {
      log.push(`remove ${target}`)
      if (failWith !== null) return fail()
      return entries.delete(target) ? { ok: true, value: true } : { ok: false, error: ERROR_NOT_FOUND }
    },
  }
}

const VALUE = 'cm-value-0123456789abcdef'

function depsOn(os: 'macos' | 'linux' | 'windows', dataDir = '/h/.kinfold'): KeyStoreDeps {
  const node = ({ macos: 'darwin', linux: 'linux', windows: 'win32' } as const)[os]
  return { platform: { os, wsl: false, node }, homeDir: '/h', dataDir, envVars: {}, security: forbiddenSecurity() }
}

function withFake(api: CredApi): ModuleTable {
  return { ...KEY_STORE_MODULES, 'credential-manager': createCredentialManagerModule(() => api) }
}

let cleanup: (() => Promise<void> | void) | null = null
afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

runKeyStoreContract('credential-manager', () => {
  const api = fakeCredApi()
  return {
    store: createCredentialManagerStore(api),
    observed: () => api.log,
    // Logs into the same list, so the contract sees every call.
    failing: () => createCredentialManagerStore(fakeCredApi(5, api.log)),
  }
})

test('a missing entry is null, not an error', () => {
  const store = createCredentialManagerStore(fakeCredApi())
  expect(store.get('db-key')).toBeNull()
  expect(store.exists('db-key')).toBe(false)
  expect(store.delete('db-key')).toBe(false)
})

test('targets are prefixed and the user name is kinfold', () => {
  const api = fakeCredApi()
  const store = createCredentialManagerStore(api)
  store.set('db-key', VALUE)
  expect(api.log).toEqual(['write kinfold/db-key'])
  expect(api.written).toEqual([{ type: CRED_TYPE_GENERIC, persist: CRED_PERSIST_LOCAL_MACHINE, userName: 'kinfold', blobSize: VALUE.length }])
  expect(api.written[0]?.persist).toBe(2)
  expect(credentialTarget('db-key')).toBe('kinfold/db-key')
  expect(store.get('db-key')).toBe(VALUE)
  for (const line of api.log) expect(line).not.toContain(VALUE)
})

test('create peeks first and writes only when there is no entry', () => {
  const api = fakeCredApi()
  const store = createCredentialManagerStore(api)
  expect(store.create('db-key', VALUE)).toBe(true)
  expect(store.create('db-key', 'other-value-fedcba')).toBe(false)
  expect(api.log).toEqual(['peek kinfold/db-key', 'write kinfold/db-key', 'peek kinfold/db-key'])
})

test('an oversize value is refused before the API is called', () => {
  const api = fakeCredApi()
  const store = createCredentialManagerStore(api)
  const text = 'Credential Manager: the value for db-key is longer than 2560 bytes'
  expect(() => store.set('db-key', 'x'.repeat(CRED_MAX_BLOB_BYTES + 1))).toThrow(new Error(text))
  // Multi-byte characters count as their UTF-8 bytes.
  expect(() => store.create('db-key', 'é'.repeat(1_281))).toThrow(new Error(text))
  expect(api.log).toEqual([])
})

test('other errors name the action, the target and the code, and 0 is unknown', () => {
  const store = createCredentialManagerStore(fakeCredApi(5))
  expect(() => store.get('db-key')).toThrow(new Error('Credential Manager: could not read kinfold/db-key (error 5)'))
  expect(() => store.exists('db-key')).toThrow(new Error('Credential Manager: could not read kinfold/db-key (error 5)'))
  expect(() => store.set('db-key', VALUE)).toThrow(new Error('Credential Manager: could not write kinfold/db-key (error 5)'))
  expect(() => store.delete('db-key')).toThrow(new Error('Credential Manager: could not delete kinfold/db-key (error 5)'))
  expect(() => createCredentialManagerStore(fakeCredApi(0)).get('db-key')).toThrow(new Error('Credential Manager: could not read kinfold/db-key (error unknown)'))
})

test('describe texts', () => {
  const store = createCredentialManagerStore(fakeCredApi())
  expect(store.describeSet('db-key')).toBe('Credential Manager: CredWriteW generic credential kinfold/db-key with value <hidden>')
  expect(store.describeDelete('db-key')).toBe('Credential Manager: CredDeleteW generic credential kinfold/db-key')
  expect(store.describeEntry('db-key')).toBe('the generic credential kinfold/db-key in Windows Credential Manager (Control Panel > Credential Manager > Windows Credentials)')
  expect([store.kind, store.label, store.place, store.notes]).toEqual(['credential-manager', 'Credential Manager', 'Windows Credential Manager', []])
  expect([credentialManagerModule.kind, credentialManagerModule.label, credentialManagerModule.location]).toEqual(['credential-manager', 'Credential Manager', undefined])
})

test('the packed CREDENTIALW has the x64 layout', () => {
  const blob = new TextEncoder().encode(VALUE)
  const packed = packCredential('kinfold/db-key', blob)
  const view = new DataView(packed.struct.buffer)
  expect(packed.struct.byteLength).toBe(CREDENTIALW_SIZE)
  expect(view.getUint32(0, true)).toBe(0)
  expect(view.getUint32(4, true)).toBe(1)
  expect(view.getBigUint64(8, true)).toBe(BigInt(ptr(packed.targetName)))
  expect([view.getBigUint64(16, true), view.getBigUint64(24, true)]).toEqual([0n, 0n])
  expect(view.getUint32(32, true)).toBe(blob.byteLength)
  expect(view.getBigUint64(40, true)).toBe(BigInt(ptr(blob)))
  expect(view.getUint32(48, true)).toBe(2)
  expect([view.getUint32(52, true), view.getBigUint64(56, true), view.getBigUint64(64, true)]).toEqual([0, 0n, 0n])
  expect(view.getBigUint64(72, true)).toBe(BigInt(ptr(packed.userName)))
  expect(decodeWide(packed.targetName)).toBe('kinfold/db-key')
  expect([...packed.targetName.slice(-2)]).toEqual([0, 0])
})

test('the lines install prints for a refused store name Credential Manager once', () => {
  const lines = (load: () => CredApi): string[] => {
    const probed = probeKeyStores(depsOn('windows'), { ...KEY_STORE_MODULES, 'credential-manager': createCredentialManagerModule(load) })
    return refusalLines({ kind: 'none', os: 'windows', store: null, refused: 'refused' in probed ? probed.refused : [] })
  }
  expect(lines(() => fakeCredApi(ERROR_NO_SUCH_LOGON_SESSION))).toEqual(['Credential Manager: not available in this logon session (error 1312)'])
  expect(lines(() => {
    throw new TypeError('no such library')
  })).toEqual(['Credential Manager: could not be loaded (TypeError)'])
  expect(lines(() => fakeCredApi())).toEqual([])
})

test('probe reads the logon-session error', async () => {
  const api = fakeCredApi(ERROR_NO_SUCH_LOGON_SESSION)
  const module = createCredentialManagerModule(() => api)
  expect(module.probe(depsOn('windows'))).toEqual({ usable: false, reason: 'not available in this logon session (error 1312)' })
  expect(api.log).toEqual(['peek kinfold/probe'])
  expect(createCredentialManagerModule(() => fakeCredApi(31)).probe(depsOn('windows'))).toEqual({ usable: false, reason: 'not available in this logon session (error 31)' })
  expect(createCredentialManagerModule(() => fakeCredApi()).probe(depsOn('windows'))).toEqual({ usable: true })
  const unloadable = createCredentialManagerModule(() => {
    throw new TypeError('no such library')
  })
  expect(unloadable.probe(depsOn('windows'))).toEqual({ usable: false, reason: 'could not be loaded (TypeError)' })

  const world: FakeWorld = createWorld({ platform: 'win32', keychainRefs: [] })
  cleanup = () => world.cleanup()
  api.log.length = 0
  expect(await install(world.env, { ...YES, dryRun: true, keyStoreModules: withFake(api) })).toBe(EXIT_OK)
  expect(world.out.some((line) => line.includes('record the key store'))).toBe(false)
  expect(world.out).toContain('database: no key store on win32 yet; the new store is created plaintext')
  // Install asked the store, and only with the probe's read.
  expect(api.log.length).toBeGreaterThan(0)
  expect(api.log.every((line) => line === 'peek kinfold/probe')).toBe(true)
})

test('a recorded Credential Manager that cannot be read makes no key', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kinfold-cm-'))
  cleanup = () => rmSync(dataDir, { recursive: true, force: true })
  writeFileSync(join(dataDir, KEY_STORE_FILE), `${JSON.stringify({ store: 'credential-manager', chosenAt: 1_792_900_000_000 })}\n`)
  const api = fakeCredApi(ERROR_NO_SUCH_LOGON_SESSION)
  const store = resolveKeyStore(dataDir, depsOn('windows', dataDir), withFake(api))
  expect(store?.kind).toBe('credential-manager')

  const path = join(dataDir, 'memory.db')
  let thrown: unknown = null
  try {
    openStoreFile(path, { keys: dbKeyStoreOf(store) }).close()
  } catch (error: unknown) {
    thrown = error
  }
  expect(thrown).toBeInstanceOf(SqliteError)
  expect((thrown as SqliteError).kind).toBe('no_key')
  expect(existsSync(path)).toBe(false)

  expect(readMaster(credentialProviderOf(store)).state).toBe('unavailable')
  expect(api.log.length).toBeGreaterThan(0)
  expect(api.log.some((line) => line.startsWith('write '))).toBe(false)
})

test('probe off Windows touches nothing', () => {
  let loads = 0
  const module = createCredentialManagerModule(() => {
    loads += 1
    return fakeCredApi()
  })
  for (const os of ['linux', 'macos'] as const) {
    expect(module.probe(depsOn(os))).toEqual({ usable: false, reason: 'Credential Manager exists only on Windows' })
  }
  expect(loads).toBe(0)
})

test('opening the store loads nothing until the first call', () => {
  let loads = 0
  const api = fakeCredApi()
  const module = createCredentialManagerModule(() => {
    loads += 1
    return api
  })
  const store = module.open(depsOn('windows'))
  expect(loads).toBe(0)
  expect(store.exists('db-key')).toBe(false)
  expect(loads).toBe(1)
  const broken = createCredentialManagerModule(() => {
    throw new TypeError('no such library')
  }).open(depsOn('windows'))
  expect(() => broken.get('db-key')).toThrow(new Error('Credential Manager could not be loaded (TypeError)'))
})
