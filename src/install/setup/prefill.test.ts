import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DB_KEY_REF } from '../../secrets/credentials'
import { type DbKeyStore, NO_DB_KEYS, newDbKey } from '../../sqlite/keys'
import { DAEMON_INFO_FILE, DB_FILE } from '../../store/data-dir'
import { openStore } from '../../store/db'
import { type ObserverSettingsInput, upsertObserverSettings } from '../../store/observer-settings-store'
import { mergeSamHooks } from '../claude-hooks'
import { putObserverSettings } from '../daemon-client'
import { type InstallEnv, installPaths } from '../env'
import { entryCommand } from '../entry'
import { hostHookInstallActions } from '../host-wiring'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { plistContent } from '../launch-agent'
import { ChoiceError, chooseObservers } from '../observer-choice'
import { runPlan } from '../plan'
import { envForDataDir } from '../../cli/kinfold'
import { type FakeWorld, YES, createWorld, fakeService, startWorldDaemon } from '../test-support'
import { UNREADABLE_OBSERVERS, lockedFolderProblem, readSetupState, savedObserversForYes } from './prefill'
import { installRecordAction } from './record'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const HAIKU: ObserverSettingsInput = { host: 'opencode', provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true }
const RECORD = { channel: 'curl', updateCheck: false, firstInstalledAt: 1_700_000_000_000 } as const
const holding = (key: string): DbKeyStore => ({ name: 'test', read: () => key, exists: () => true })

function make(options: Parameters<typeof createWorld>[0] = {}): FakeWorld {
  world = createWorld(options)
  return world
}

async function markInstalled(w: FakeWorld): Promise<void> {
  mkdirSync(w.dataDir, { recursive: true })
  await runPlan(w.env, [installRecordAction(w.dataDir, RECORD)], false)
}

function seedPlainStore(w: FakeWorld, input: ObserverSettingsInput): void {
  const store = openStore(w.dataDir, { keys: NO_DB_KEYS })
  try {
    upsertObserverSettings(store.db, input, 1)
  } finally {
    store.db.close()
  }
}

const besideStore = (w: FakeWorld): string[] => readdirSync(w.dataDir).filter((name) => name.startsWith(DB_FILE)).sort()

function writePlist(w: FakeWorld, edit: (text: string) => string = (text) => text): void {
  const paths = installPaths(w.env)
  mkdirSync(paths.launchAgentsDir, { recursive: true })
  writeFileSync(paths.launchAgentPlist, edit(plistContent(w.env, DEFAULT_PORT)))
}

test('pre-fill reads hosts from wiring', async () => {
  const w = make()
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  const wired = mergeSamHooks({}, { entry: entryCommand(w.env.mode, 'hook', w.dataDir) }).settings
  writeFileSync(paths.claudeSettings, JSON.stringify(wired))
  await runPlan(w.env, hostHookInstallActions(w.env, 'codex'), false)
  const state = await readSetupState(w.env)
  expect(state.wiredHosts).toEqual(['claude-code', 'codex'])
})

test('a first install has nothing to pre-fill and a default channel, update check on', async () => {
  const w = make()
  const state = await readSetupState(w.env)
  expect(state).toMatchObject({ installed: false, dataDir: w.dataDir, wiredHosts: [], encryption: 'new', port: 37811, updateCheck: true, channel: 'checkout', firstInstalledAt: null, observersError: null })
  expect(state.observers.size).toBe(0)
})

test('install.json supplies the update choice and the first-install time', async () => {
  const w = make()
  await markInstalled(w)
  const state = await readSetupState(w.env)
  expect(state).toMatchObject({ installed: true, updateCheck: false, firstInstalledAt: RECORD.firstInstalledAt })
})

test('observers come from the daemon when it is up', async () => {
  const w = make({ keychainRefs: [DB_KEY_REF] })
  w.keychainValues.set(DB_KEY_REF, newDbKey())
  await markInstalled(w)
  const daemon = startWorldDaemon(w, w.dataDir)
  try {
    await putObserverSettings(w.env, HAIKU)
    const state = await readSetupState(w.env)
    expect(state.observers.get('opencode')).toEqual(HAIKU)
    expect(state.observersError).toBeNull()
    expect(w.fetches).toContain('GET /observer/settings')
  } finally {
    await daemon.stop()
  }
})

test('observers come from the store when the daemon is down', async () => {
  const w = make()
  await markInstalled(w)
  seedPlainStore(w, HAIKU)
  expect(besideStore(w)).toEqual([DB_FILE])
  const state = await readSetupState(w.env)
  expect(state.observers.get('opencode')).toEqual(HAIKU)
  expect(state.encryption).toBe('off')
  // The read writes nothing beside the store: no -wal or -shm appears.
  expect(besideStore(w)).toEqual([DB_FILE])
})

test('a store whose WAL side files are there is read through them and keeps them', async () => {
  const w = make()
  await markInstalled(w)
  seedPlainStore(w, HAIKU)
  const open = openStore(w.dataDir, { keys: NO_DB_KEYS })
  try {
    expect(besideStore(w)).toEqual([DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`])
    expect((await readSetupState(w.env)).observers.get('opencode')).toEqual(HAIKU)
    expect(besideStore(w)).toEqual([DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`])
  } finally {
    open.db.close()
  }
})

test('saved rows with no install.json and no plist still reach --yes', async () => {
  const w = make()
  seedPlainStore(w, HAIKU)
  const env: InstallEnv = { ...w.env, service: null }
  const state = await readSetupState(env)
  expect(state.installed).toBe(false)
  expect(state.observers.get('opencode')).toEqual(HAIKU)
  const [choice] = await chooseObservers(env, ['opencode'], { ...YES, saved: savedObserversForYes(state, ['opencode'], []) })
  expect(choice?.input).toEqual(HAIKU)
  expect(choice?.origin).toBe('saved')
})

test('an encrypted store is read through the Keychain key when the daemon is down', async () => {
  const w = make({ keychainRefs: [DB_KEY_REF] })
  await markInstalled(w)
  const key = newDbKey()
  w.keychainValues.set(DB_KEY_REF, key)
  const store = openStore(w.dataDir, { keys: holding(key) })
  upsertObserverSettings(store.db, HAIKU, 1)
  store.db.close()
  const before = readFileSync(join(w.dataDir, DB_FILE))
  expect(besideStore(w)).toEqual([DB_FILE])
  const state = await readSetupState(w.env)
  expect(besideStore(w)).toEqual([DB_FILE])
  expect(state.encryption).toBe('on')
  expect(state.observers.get('opencode')).toEqual(HAIKU)
  expect(readFileSync(join(w.dataDir, DB_FILE)).equals(before)).toBe(true)
  expect(w.out.join('\n')).not.toContain(key)
  expect(w.securityCalls.every((call) => !call.args.includes('add-generic-password'))).toBe(true)
})

test('--yes on a re-run keeps the saved observer', async () => {
  const w = make()
  await markInstalled(w)
  seedPlainStore(w, HAIKU)
  const state = await readSetupState(w.env)
  const saved = savedObserversForYes(state, ['opencode'], [])
  const [choice] = await chooseObservers(w.env, ['opencode'], { ...YES, saved })
  expect(choice?.input).toEqual(HAIKU)
  expect(choice?.check).toBe('unchanged')
  expect(choice?.origin).toBe('saved')
  expect(w.checks).toEqual([])
  expect(choice?.input.provider).not.toBe('openrouter')
})

test('--yes with a --observer flag still takes the flag, and a host without a row takes the default', async () => {
  const w = make()
  const saved = new Map([['opencode', HAIKU]] as const)
  const flags = [{ host: 'opencode', provider: 'claude-cli', model: 'sonnet' }] as const
  const [flagged] = await chooseObservers(w.env, ['opencode'], { ...YES, saved, flags, skipCheck: true })
  expect(flagged?.input.model).toBe('sonnet')
  const [fresh] = await chooseObservers(w.env, ['claude-code'], { ...YES, saved, skipCheck: true })
  expect(fresh?.origin).toBe('default')
})

/** A file with no SQLite header is an encrypted store; the world's Keychain answers the db-key with something that is no key. */
function encryptedStoreWithBadKey(w: FakeWorld): void {
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(join(w.dataDir, DB_FILE), Buffer.alloc(4096, 7))
}

test('an unreadable encrypted store refuses under --yes', async () => {
  const w = make({ keychainRefs: [DB_KEY_REF] })
  await markInstalled(w)
  encryptedStoreWithBadKey(w)
  const state = await readSetupState(w.env)
  expect(state.observers.size).toBe(0)
  expect(state.observersError).toBe(UNREADABLE_OBSERVERS)
  expect(() => savedObserversForYes(state, ['opencode'], [])).toThrow(new ChoiceError('cannot read the saved observer settings (the daemon is down and memory.db did not open); start the daemon or pass --observer <host>=<provider>:<model>'))
  // A host the caller named itself does not depend on the saved row.
  expect(savedObserversForYes(state, ['opencode'], [{ host: 'opencode', provider: 'claude-cli', model: 'haiku' }]).size).toBe(0)
  expect(w.securityCalls.every((call) => !call.args.includes('add-generic-password'))).toBe(true)
})

test('a missing Keychain key refuses the same way', async () => {
  const w = make()
  await markInstalled(w)
  encryptedStoreWithBadKey(w)
  const state = await readSetupState(w.env)
  expect(state.observersError).toBe(UNREADABLE_OBSERVERS)
})

test('the port comes from the plist, its default when the plist names none, else daemon.json', async () => {
  const w = make()
  const withPort = (text: string): string => text.replace('    <key>HOME</key>', '    <key>KINFOLD_PORT</key><string>4511</string>\n    <key>HOME</key>')
  writePlist(w, withPort)
  expect((await readSetupState(w.env)).port).toBe(4511)
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(join(w.dataDir, DAEMON_INFO_FILE), JSON.stringify({ pid: 1, port: 4242 }))
  writePlist(w)
  expect((await readSetupState(w.env)).port).toBe(DEFAULT_PORT)
  rmSync(installPaths(w.env).launchAgentPlist)
  expect((await readSetupState(w.env)).port).toBe(4242)
})

test('a pre-wizard install counts as installed', async () => {
  const w = make()
  const elsewhere = join(w.root, 'My Memory')
  writePlist({ ...w, env: { ...w.env, dataDir: elsewhere } } as FakeWorld)
  const state = await readSetupState(w.env)
  expect(state.installed).toBe(true)
  expect(state.dataDir).toBe(elsewhere)
  expect(state.firstInstalledAt).toBeNull()
})

test('a service injected as the fake names the folder and port too', async () => {
  const w = make()
  const env: InstallEnv = { ...w.env, service: fakeService({ dataDir: '/Users/me/My Memory', port: 4001 }) }
  const state = await readSetupState(env)
  expect(state).toMatchObject({ installed: true, dataDir: '/Users/me/My Memory', port: 4001 })
})

test('a different --data-dir on an installed machine is refused', async () => {
  const w = make()
  await markInstalled(w)
  const state = await readSetupState(w.env)
  const problem = lockedFolderProblem(state, join(w.root, 'elsewhere'))
  expect(problem).toContain('Chosen at first install. To use another folder, uninstall and reinstall.')
  expect(problem).toContain(w.dataDir)
  expect(lockedFolderProblem(state, w.dataDir)).toBeNull()
  expect(lockedFolderProblem(state, `${w.dataDir}/`)).toBeNull()
  expect(lockedFolderProblem(state, null)).toBeNull()
  const first = await readSetupState({ ...w.env, dataDir: join(w.root, 'fresh') })
  expect(lockedFolderProblem(first, '/anywhere/at/all')).toBeNull()
})

test('the lock fires when --data-dir names another folder, even with no service to name the installed one', async () => {
  const w = make()
  await markInstalled(w)
  const other = join(w.root, 'elsewhere')
  // runKinfold applies envForDataDir before install runs; there is no plist and no service here.
  const env = envForDataDir({ ...w.env, service: null }, other)
  expect(env.dataDir).toBe(other)
  const state = await readSetupState(env)
  expect(state).toMatchObject({ installed: true, dataDir: w.dataDir })
  const problem = lockedFolderProblem(state, other)
  expect(problem).toContain('Chosen at first install. To use another folder, uninstall and reinstall.')
  expect(lockedFolderProblem(state, w.dataDir)).toBeNull()
})

test('a lone non-empty -wal is refused rather than read without it, and --yes names --observer', async () => {
  const w = make()
  await markInstalled(w)
  seedPlainStore(w, HAIKU)
  // A daemon that crashed mid-write can leave committed rows in a -wal with no -shm; immutable would skip them.
  writeFileSync(join(w.dataDir, `${DB_FILE}-wal`), Buffer.alloc(4096, 1))
  const before = readFileSync(join(w.dataDir, `${DB_FILE}-wal`))
  const state = await readSetupState(w.env)
  expect(state.observersError).toBe(UNREADABLE_OBSERVERS)
  expect(state.observers.size).toBe(0)
  expect(() => savedObserversForYes(state, ['opencode'], [])).toThrow(new ChoiceError(UNREADABLE_OBSERVERS))
  expect(besideStore(w)).toEqual([DB_FILE, `${DB_FILE}-wal`])
  expect(readFileSync(join(w.dataDir, `${DB_FILE}-wal`)).equals(before)).toBe(true)
})

test('an empty lone -wal is read with immutable, as nothing in it can be missed', async () => {
  const w = make()
  await markInstalled(w)
  seedPlainStore(w, HAIKU)
  writeFileSync(join(w.dataDir, `${DB_FILE}-wal`), '')
  const state = await readSetupState(w.env)
  expect(state.observersError).toBeNull()
  expect(state.observers.get('opencode')).toEqual(HAIKU)
})

test('with both side files there, a failed plain open refuses instead of falling back to immutable', async () => {
  const w = make()
  await markInstalled(w)
  seedPlainStore(w, HAIKU)
  // Side files as a running daemon leaves them, kept after the writer closes so no other connection in this process shares them.
  const open = openStore(w.dataDir, { keys: NO_DB_KEYS })
  const wal = join(w.dataDir, `${DB_FILE}-wal`)
  const shm = join(w.dataDir, `${DB_FILE}-shm`)
  const kept = [readFileSync(wal), readFileSync(shm)] as const
  open.db.close()
  writeFileSync(wal, kept[0])
  writeFileSync(shm, kept[1])
  chmodSync(shm, 0o000)
  try {
    const state = await readSetupState(w.env)
    expect(state.observersError).toBe(UNREADABLE_OBSERVERS)
    expect(state.observers.size).toBe(0)
  } finally {
    chmodSync(shm, 0o600)
  }
})
