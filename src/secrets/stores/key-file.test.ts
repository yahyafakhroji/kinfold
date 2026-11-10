import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly, skipsOn, windowsOnly } from '../../../test/platform-guards'
import { currentPlatform } from '../../platform/platform'
import type { KeyStoreDeps } from '../key-store'
import { runKeyStoreContract } from './contract'
import { KEY_FILE_NOTES, createKeyFileStore, keyFileDir, keyFileModule, keyFilePath, probeKeyFile } from './key-file'

const VALUE = 'key-file-value-0123456789abcdef'
const LINUX = { os: 'linux', wsl: false, node: 'linux' } as const
const ON_WINDOWS = skipsOn('posix', currentPlatform().os)

const homes: string[] = []

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'kinfold-key-file-'))
  homes.push(home)
  return home
}

function cleanHomes(): void {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}

afterEach(cleanHomes)

function depsFor(home: string, extra: Partial<KeyStoreDeps> = {}): KeyStoreDeps {
  return {
    platform: LINUX,
    homeDir: home,
    dataDir: join(home, '.kinfold'),
    envVars: {},
    security: () => {
      throw new Error('a key file store must never run security')
    },
    ...extra,
  }
}

function traced(dir: string, dataDir: string) {
  const events: string[] = []
  const store = createKeyFileStore(dir, { dataDir, trace: (event) => events.push(event) })
  return { store, events }
}

function messageOf(action: () => unknown): string {
  try {
    action()
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a failure')
}

const modeOf = (path: string) => statSync(path).mode & 0o777
const readsAny = (events: readonly string[]) => events.some((event) => event.startsWith('read '))

// Every contract case touches file modes or getuid, which Windows lacks.
describe.skipIf(ON_WINDOWS)('key file contract', () => {
  runKeyStoreContract(
    'key file',
    () => {
      const home = tempHome()
      const dataDir = join(home, '.kinfold')
      const events: string[] = []
      const trace = (event: string) => events.push(event)
      const store = createKeyFileStore(join(home, '.config', 'kinfold'), { dataDir, trace })
      // A folder whose parent is a regular file: every filesystem call fails with ENOTDIR.
      const failing = () => {
        writeFileSync(join(home, 'blocker'), '')
        return createKeyFileStore(join(home, 'blocker', 'kinfold'), { dataDir, trace })
      }
      return { store, observed: () => events, failing }
    },
    cleanHomes,
  )
})

posixOnly('file modes')('a failing folder names the errno, not the error text', () => {
  const home = tempHome()
  writeFileSync(join(home, 'blocker'), '')
  const dir = join(home, 'blocker', 'kinfold')
  const store = createKeyFileStore(dir, { dataDir: join(home, '.kinfold') })
  expect(messageOf(() => store.get('db-key'))).toBe(`key file: read ${dir} failed (ENOTDIR)`)
  expect(messageOf(() => store.set('db-key', VALUE))).toBe(`key file: write ${dir} failed (ENOTDIR)`)
})

test('the folder follows XDG_CONFIG_HOME only when it is absolute', () => {
  const home = join('/home', 'someone')
  const at = (envVars: Record<string, string | undefined>) => keyFileDir({ homeDir: home, envVars })
  expect(at({ XDG_CONFIG_HOME: '/x/cfg' })).toBe(join('/x/cfg', 'kinfold'))
  const fallback = join(home, '.config', 'kinfold')
  expect(at({ XDG_CONFIG_HOME: 'rel' })).toBe(fallback)
  expect(at({ XDG_CONFIG_HOME: '' })).toBe(fallback)
  expect(at({})).toBe(fallback)
})

test('a recorded location wins over the environment', () => {
  const deps = depsFor(join('/home', 'someone'), { envVars: { XDG_CONFIG_HOME: '/other' } })
  expect(keyFileDir({ ...deps, location: '/rec/kinfold' })).toBe('/rec/kinfold')
  expect(keyFileModule.location?.(deps)).toBe(join('/other', 'kinfold'))
  expect(keyFileModule.location?.({ ...deps, location: '/rec/kinfold' })).toBe(join('/other', 'kinfold'))
})

test('there is one file per account', () => {
  expect(keyFilePath(join('/k'), 'db-key')).toBe(join('/k', 'db-key.key'))
})

posixOnly('file modes')('a first write makes a 0700 folder and a 0600 file', () => {
  const home = tempHome()
  const config = join(home, '.config')
  mkdirSync(config)
  chmodSync(config, 0o755)
  const dir = join(config, 'kinfold')
  const store = createKeyFileStore(dir, { dataDir: join(home, '.kinfold') })
  store.set('db-key', VALUE)
  expect(modeOf(dir)).toBe(0o700)
  expect(modeOf(keyFilePath(dir, 'db-key'))).toBe(0o600)
  expect(modeOf(config)).toBe(0o755)
  expect(store.get('db-key')).toBe(VALUE)
})

posixOnly('file modes')('create never replaces an entry another store wrote', () => {
  const home = tempHome()
  const dir = join(home, '.config', 'kinfold')
  const dataDir = join(home, '.kinfold')
  const first = createKeyFileStore(dir, { dataDir })
  const second = createKeyFileStore(dir, { dataDir })
  expect(first.create('db-key', 'value-a')).toBe(true)
  expect(second.create('db-key', 'value-b')).toBe(false)
  expect(second.get('db-key')).toBe('value-a')
  expect(readdirSync(dir)).toEqual(['db-key.key'])
})

posixOnly('file modes')('a loose folder or file is refused without reading it', () => {
  const home = tempHome()
  const dir = join(home, '.config', 'kinfold')
  const dataDir = join(home, '.kinfold')
  createKeyFileStore(dir, { dataDir }).set('db-key', VALUE)

  chmodSync(dir, 0o755)
  const loose = traced(dir, dataDir)
  const folderMessage = `key file: ${dir} is open to other users (mode 755); run chmod 700 ${dir}`
  expect(messageOf(() => loose.store.get('db-key'))).toBe(folderMessage)
  expect(messageOf(() => loose.store.set('db-key', VALUE))).toBe(folderMessage)
  expect(readsAny(loose.events)).toBe(false)

  chmodSync(dir, 0o700)
  const path = keyFilePath(dir, 'db-key')
  chmodSync(path, 0o644)
  const looseFile = traced(dir, dataDir)
  expect(messageOf(() => looseFile.store.get('db-key'))).toBe(`key file: ${path} is open to other users (mode 644); run chmod 600 ${path}`)
  expect(readsAny(looseFile.events)).toBe(false)
})

posixOnly('file modes')('a symlinked key file is refused', () => {
  const home = tempHome()
  const dir = join(home, '.config', 'kinfold')
  const store = createKeyFileStore(dir, { dataDir: join(home, '.kinfold') })
  store.set('other', VALUE)
  symlinkSync(keyFilePath(dir, 'other'), keyFilePath(dir, 'db-key'))
  expect(messageOf(() => store.get('db-key'))).toBe(`key file: ${keyFilePath(dir, 'db-key')} is not a regular file`)
})

posixOnly('file modes')('a symlinked key folder is refused', () => {
  const home = tempHome()
  const real = join(home, 'real')
  mkdirSync(real, { mode: 0o700 })
  const dir = join(home, 'linked')
  symlinkSync(real, dir)
  const store = createKeyFileStore(dir, { dataDir: join(home, '.kinfold') })
  expect(messageOf(() => store.set('db-key', VALUE))).toBe(`key file: ${dir} is not a folder`)
  expect(readdirSync(real)).toEqual([])
})

posixOnly('file modes')('a damaged key file names the file, never the content', () => {
  const home = tempHome()
  const dir = join(home, '.config', 'kinfold')
  const store = createKeyFileStore(dir, { dataDir: join(home, '.kinfold') })
  store.set('db-key', VALUE)
  const path = keyFilePath(dir, 'db-key')
  writeFileSync(path, 'has space\n', { mode: 0o600 })
  const message = messageOf(() => store.get('db-key'))
  expect(message).toBe(`key file: ${path} does not hold a valid key`)
  expect(message).not.toContain('has space')
})

posixOnly('file modes')('a key folder inside the memory folder is refused', () => {
  const home = tempHome()
  const dataDir = join(home, 'mem')
  const inside = (dir: string) => `the key folder ${dir} is inside the memory folder ${dataDir}; set XDG_CONFIG_HOME to a folder outside it`

  const fromEnv = depsFor(home, { dataDir, envVars: { XDG_CONFIG_HOME: dataDir } })
  const dir = join(dataDir, 'kinfold')
  expect(probeKeyFile(fromEnv)).toEqual({ usable: false, reason: inside(dir) })
  expect(messageOf(() => keyFileModule.open(fromEnv).set('db-key', VALUE))).toBe(`key file: ${inside(dir)}`)
  expect(existsSync(dir)).toBe(false)

  const recordedDir = join(dataDir, 'keys')
  const recorded = depsFor(home, { dataDir, location: recordedDir })
  expect(probeKeyFile(recorded)).toEqual({ usable: false, reason: inside(recordedDir) })
  expect(messageOf(() => keyFileModule.open(recorded).set('db-key', VALUE))).toBe(`key file: ${inside(recordedDir)}`)
})

posixOnly('file modes')('a memory folder reached through a symlink still keeps the key folder out', () => {
  const home = tempHome()
  const sync = join(home, 'Sync')
  mkdirSync(sync)
  const dataDir = join(home, 'mem')
  symlinkSync(sync, dataDir)
  const deps = depsFor(home, { dataDir, envVars: { XDG_CONFIG_HOME: join(sync, 'cfg') } })
  const reason = `the key folder ${join(sync, 'cfg', 'kinfold')} is inside the memory folder ${dataDir}; set XDG_CONFIG_HOME to a folder outside it`
  expect(probeKeyFile(deps)).toEqual({ usable: false, reason })
  expect(messageOf(() => keyFileModule.open(deps).set('db-key', VALUE))).toBe(`key file: ${reason}`)
  expect(readdirSync(sync)).toEqual([])
})

posixOnly('file modes')('a key folder reached through a symlink into the memory folder is refused', () => {
  const home = tempHome()
  const dataDir = join(home, 'Sync')
  mkdirSync(dataDir)
  const link = join(home, 'link')
  symlinkSync(dataDir, link)
  const deps = depsFor(home, { dataDir, envVars: { XDG_CONFIG_HOME: join(link, 'cfg') } })
  const reason = `the key folder ${join(link, 'cfg', 'kinfold')} is inside the memory folder ${dataDir}; set XDG_CONFIG_HOME to a folder outside it`
  expect(probeKeyFile(deps)).toEqual({ usable: false, reason })
  expect(messageOf(() => keyFileModule.open(deps).set('db-key', VALUE))).toBe(`key file: ${reason}`)
  expect(readdirSync(dataDir)).toEqual([])
})

posixOnly('file modes')('a ~/.config linked into a dotfiles folder is usable', () => {
  const home = tempHome()
  const target = join(home, 'dotfiles', 'config')
  mkdirSync(target, { recursive: true })
  symlinkSync(target, join(home, '.config'))
  const deps = depsFor(home)
  expect(probeKeyFile(deps)).toEqual({ usable: true })
  const store = keyFileModule.open(deps)
  store.set('db-key', VALUE)
  expect(store.get('db-key')).toBe(VALUE)
  expect(modeOf(join(target, 'kinfold'))).toBe(0o700)
})

posixOnly('file modes')('the probe never creates the folder', () => {
  const home = tempHome()
  expect(probeKeyFile(depsFor(home))).toEqual({ usable: true })
  expect(existsSync(join(home, '.config'))).toBe(false)
  expect(probeKeyFile(depsFor(home, { platform: { os: 'macos', wsl: false, node: 'darwin' } }))).toEqual({ usable: false, reason: 'not Linux' })
})

posixOnly('file modes')('the probe refuses an unsafe folder and an unwritable ancestor', () => {
  const home = tempHome()
  const dir = join(home, '.config', 'kinfold')
  mkdirSync(dir, { recursive: true })
  chmodSync(dir, 0o755)
  expect(probeKeyFile(depsFor(home))).toEqual({ usable: false, reason: `${dir} is open to other users (mode 755); run chmod 700 ${dir}` })

  const locked = join(home, 'locked')
  mkdirSync(locked)
  chmodSync(locked, 0o500)
  try {
    const probe = probeKeyFile(depsFor(home, { envVars: { XDG_CONFIG_HOME: join(locked, 'cfg') } }))
    // root may write anywhere, so the refusal only shows for an ordinary user.
    if (process.getuid?.() !== 0) expect(probe).toEqual({ usable: false, reason: `${locked} is not writable` })
  } finally {
    chmodSync(locked, 0o700)
  }
})

windowsOnly('no POSIX file owners')('the probe is unusable on a host without POSIX file owners', () => {
  expect(probeKeyFile(depsFor(tempHome()))).toEqual({ usable: false, reason: 'this host has no POSIX file owners' })
})

test('describe texts hide the value', () => {
  const home = join('/home', 'someone')
  const store = keyFileModule.open(depsFor(home))
  const path = join(home, '.config', 'kinfold', 'openrouter.key')
  expect(store.describeSet('openrouter')).toBe(`key file: write ${path} (mode 0600, value <hidden>)`)
  expect(store.describeDelete('openrouter')).toBe(`key file: remove ${path}`)
  expect(store.describeEntry('openrouter')).toBe(`the key file ${path}`)
  expect([store.kind, store.label, store.place]).toEqual(['key-file', 'key file', `the key files in ${join('~', '.config', 'kinfold')}`])
})

test('the notes say what a key file protects and what it does not', () => {
  expect(KEY_FILE_NOTES).toEqual([
    'Encryption with a key file protects copies, backups and synced folders.',
    'It does not protect against anyone who can log in as you.',
  ])
  expect(keyFileModule.open(depsFor(join('/home', 'someone'))).notes).toEqual(KEY_FILE_NOTES)
  expect([keyFileModule.kind, keyFileModule.label]).toEqual(['key-file', 'key file'])
})
