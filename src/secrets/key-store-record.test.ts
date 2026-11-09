import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OsName, PlatformInfo } from '../platform/platform'
import type { KeyStore, KeyStoreDeps, KeyStoreKind, KeyStoreModule } from './key-store'
import { DB_KEY_REF } from './credentials'
import { KEY_STORE_FILE, processKeyStoreDeps, readKeyStoreRecord, recordMismatchMessage, recordUnreadableMessage, resolveKeyStore } from './key-store-record'
import { LOOKUP_TIMEOUT_MS, SECURITY_BINARY, SECURITY_TIMEOUT_MS, type SecuritySpawn, type SecuritySpawnOptions, createSecurityRunner } from './stores/keychain'
import { KEY_STORE_MODULES } from './stores/select'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-record-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const NODE: Readonly<Record<OsName, NodeJS.Platform>> = { macos: 'darwin', linux: 'linux', windows: 'win32' }

function depsOn(os: OsName, envVars: Readonly<Record<string, string | undefined>> = {}): KeyStoreDeps {
  const platform: PlatformInfo = { os, wsl: false, node: NODE[os] }
  return { platform, homeDir: '/h', dataDir: dir, envVars, security: () => ({ exitCode: 51, stdout: '' }) }
}

function writeRecord(content: string): string {
  const path = join(dir, KEY_STORE_FILE)
  writeFileSync(path, content)
  return path
}

interface Spy {
  modules: Readonly<Record<KeyStoreKind, KeyStoreModule>>
  probes: () => number
  opened: KeyStoreDeps[]
}

function spyModules(): Spy {
  let probes = 0
  const opened: KeyStoreDeps[] = []
  const wrap = (module: KeyStoreModule): KeyStoreModule => ({
    ...module,
    probe: (deps) => {
      probes += 1
      return module.probe(deps)
    },
    open: (deps): KeyStore => {
      opened.push(deps)
      return module.open(deps)
    },
  })
  const modules = Object.fromEntries(Object.entries(KEY_STORE_MODULES).map(([kind, module]) => [kind, wrap(module)])) as Record<KeyStoreKind, KeyStoreModule>
  return { modules, probes: () => probes, opened }
}

test('a strict record parse', () => {
  expect(readKeyStoreRecord(dir)).toEqual({ state: 'missing' })
  writeRecord('{"store":"key-file","chosenAt":1,"location":"/h/.config/kinfold"}')
  expect(readKeyStoreRecord(dir)).toEqual({ state: 'present', record: { store: 'key-file', chosenAt: 1, location: '/h/.config/kinfold' } })
  for (const bad of [
    '{"store":"vault","chosenAt":1}',
    '{"store":"keychain","chosenAt":1',
    '{"store":"keychain"}',
    '{"store":"key-file","chosenAt":1,"location":"relative/keys"}',
    '{"store":"keychain","chosenAt":1,"extra":true}',
    '{"store":"keychain","chosenAt":0}',
    '{"store":"keychain","chosenAt":1.5}',
    '{"store":"key-file","chosenAt":1,"location":"/h/\\u0000x"}',
    '["keychain"]',
    'null',
    '',
  ]) {
    writeRecord(bad)
    expect(readKeyStoreRecord(dir)).toEqual({ state: 'unreadable' })
  }
})

test('a record that cannot be read is unreadable, never missing', () => {
  // A folder in the file's place fails with EISDIR, not ENOENT.
  mkdirSync(join(dir, KEY_STORE_FILE))
  expect(readKeyStoreRecord(dir)).toEqual({ state: 'unreadable' })
})

test('the recorded location reaches the store', () => {
  writeRecord('{"store":"key-file","chosenAt":1,"location":"/x/keys"}')
  const spy = spyModules()
  const store = resolveKeyStore(dir, depsOn('linux'), spy.modules)
  expect(store?.kind).toBe('key-file')
  expect(spy.opened).toHaveLength(1)
  expect(spy.opened[0]!.location).toBe('/x/keys')
  expect(spy.opened[0]!.dataDir).toBe(dir)
})

test('resolveKeyStore never probes', () => {
  const spy = spyModules()
  writeRecord('{"store":"keychain","chosenAt":1}')
  resolveKeyStore(dir, depsOn('macos'), spy.modules)
  rmSync(join(dir, KEY_STORE_FILE))
  resolveKeyStore(dir, depsOn('macos'), spy.modules)
  resolveKeyStore(dir, depsOn('linux'), spy.modules)
  writeRecord('{"store":')
  expect(() => resolveKeyStore(dir, depsOn('macos'), spy.modules)).toThrow()
  expect(spy.probes()).toBe(0)
})

test('a missing record means the Keychain on macOS and no store elsewhere', () => {
  expect(resolveKeyStore(dir, depsOn('macos'))?.kind).toBe('keychain')
  expect(resolveKeyStore(dir, depsOn('linux'))).toBeNull()
  expect(resolveKeyStore(dir, depsOn('windows'))).toBeNull()
})

test('an unreadable or foreign record fails with the fixed message', () => {
  const path = writeRecord('{"store":"keychain"}')
  expect(() => resolveKeyStore(dir, depsOn('macos'))).toThrow(recordUnreadableMessage(path))
  expect(() => resolveKeyStore(dir, depsOn('linux'))).toThrow(recordUnreadableMessage(path))
  writeRecord('{"store":"credential-manager","chosenAt":1}')
  const macos = depsOn('macos')
  expect(() => resolveKeyStore(dir, macos)).toThrow(recordMismatchMessage(path, 'credential-manager', macos.platform))
  expect(recordMismatchMessage(path, 'credential-manager', macos.platform)).toBe(
    `${path} names the ${KEY_STORE_MODULES['credential-manager'].label}, which is not a key store on macos. Nothing was changed and no new key was made`,
  )
  expect(existsSync(join(dir, 'memory.db'))).toBe(false)
})

test('the test switch wins over a record', () => {
  writeRecord('{"store":"keychain","chosenAt":1}')
  expect(resolveKeyStore(dir, depsOn('macos', { KINFOLD_DB_KEYSTORE: 'none', NODE_ENV: 'test' }))).toBeNull()
  // Without NODE_ENV=test the switch does nothing, so no production env turns the store off.
  expect(resolveKeyStore(dir, depsOn('macos', { KINFOLD_DB_KEYSTORE: 'none' }))?.kind).toBe('keychain')
  writeRecord('{"store":')
  expect(resolveKeyStore(dir, depsOn('macos', { KINFOLD_DB_KEYSTORE: 'none', NODE_ENV: 'test' }))).toBeNull()
})

function recordingSpawn(): { spawn: SecuritySpawn; seen: { cmd: string[]; options: SecuritySpawnOptions }[] } {
  const seen: { cmd: string[]; options: SecuritySpawnOptions }[] = []
  return { seen, spawn: (cmd, options) => (seen.push({ cmd, options }), { exitCode: 44, stdout: Buffer.from('') }) }
}

test('every process read of a key store uses the 5 s lookup timeout', () => {
  expect(LOOKUP_TIMEOUT_MS).toBe(5_000)
  const { spawn, seen } = recordingSpawn()
  writeRecord('{"store":"keychain","chosenAt":1}')
  // macOS forced, so the Keychain path runs on any host; the fake spawn never starts a child.
  const deps = { ...processKeyStoreDeps(dir, { HOME: '/h' }, spawn), platform: depsOn('macos').platform }
  const store = resolveKeyStore(dir, deps)
  expect(store?.get(DB_KEY_REF)).toBeNull()
  expect(store?.exists(DB_KEY_REF)).toBe(false)
  rmSync(join(dir, KEY_STORE_FILE))
  resolveKeyStore(dir, deps)?.get('openrouter')
  expect(seen.length).toBeGreaterThan(0)
  for (const { cmd, options } of seen) {
    expect(cmd[0]).toBe(SECURITY_BINARY)
    expect(options.timeout).toBe(LOOKUP_TIMEOUT_MS)
    expect(options.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/h' })
  }
})

test('the child gets HOME as the process has it, empty when unset', () => {
  const { spawn, seen } = recordingSpawn()
  processKeyStoreDeps(dir, {}, spawn).security({ args: ['find-generic-password'] })
  expect(seen[0]!.options.env.HOME).toBe('')
})

test('installer writes keep the longer timeout', () => {
  expect(SECURITY_TIMEOUT_MS).toBe(10_000)
  const { spawn, seen } = recordingSpawn()
  createSecurityRunner('/h', undefined, spawn)({ args: ['-i'], stdin: 'x' })
  expect(seen[0]!.options.timeout).toBe(SECURITY_TIMEOUT_MS)
})
