import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InstallRecord } from '../install/setup/record'
import { type AutoUpdateDeps, ERROR_BACKOFF_MS, QUIET_MS, autoUpdateDecision, createAutoUpdateTicker, runAutoUpdateTick, startAutoUpdates } from './auto'
import { type AutoUpdateState, mergeAutoState, readAutoState } from './auto-state'
import { acquireUpdateLock } from './lock'
import { type UpdateState, writeUpdateState } from './state'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1 }
const NOW = 1_792_900_000_000
const CHECKED = NOW - 3_600_000
const found = (latestVersion: string | null, checkedAt: number | null = CHECKED): UpdateState => ({ lastAttemptAt: checkedAt, latestVersion, checkedAt, notified: {} })
const NO_AUTO: AutoUpdateState = { attempt: null, failure: null, updated: null }
const quiet = { now: NOW, lastEventAt: NOW - QUIET_MS, lockHolder: null }
const decide = (change: Partial<Parameters<typeof autoUpdateDecision>[0]> = {}) =>
  autoUpdateDecision({ running: '0.2.0', record: RECORD, env: {}, state: found('0.2.1'), auto: NO_AUTO, ...quiet, ...change })

test('a patch release is applied once ten quiet minutes have passed', () => {
  expect(QUIET_MS).toBe(600_000)
  expect(decide()).toEqual({ apply: true, version: '0.2.1' })
})

test('a minor, a major or a prerelease is left for kinfold update', () => {
  for (const latest of ['0.3.0', '1.0.0', '0.2.1-rc.1', '0.2.0', null]) expect(decide({ state: found(latest) })).toEqual({ apply: false, reason: 'no-patch' })
})

test('a running prerelease never updates itself', () => {
  expect(decide({ running: '0.2.0-rc.1', state: found('0.2.0') })).toEqual({ apply: false, reason: 'no-patch' })
  expect(decide({ running: '0.2.0-rc.1', state: found('0.2.1') })).toEqual({ apply: false, reason: 'no-patch' })
})

test('every off switch stops it', () => {
  for (const change of [{ record: { ...RECORD, autoUpdate: false } }, { record: { ...RECORD, updateCheck: false } }, { record: { ...RECORD, channel: 'checkout' as const } }, { record: null }, { env: { KINFOLD_NO_AUTO_UPDATE: '1' } }, { env: { KINFOLD_NO_UPDATE_CHECK: '1' } }]) {
    expect(decide(change)).toEqual({ apply: false, reason: 'off' })
  }
})

test('an agent event in the last ten minutes holds it back', () => {
  expect(decide({ lastEventAt: NOW - QUIET_MS + 1 })).toEqual({ apply: false, reason: 'busy' })
  expect(decide({ lastEventAt: NOW })).toEqual({ apply: false, reason: 'busy' })
})

test('an update that is already running is not started twice', () => {
  expect(decide({ lockHolder: 4242 })).toEqual({ apply: false, reason: 'running' })
})

test('one attempt per daily check: the same check never retries, the next one does', () => {
  const tried: AutoUpdateState = { ...NO_AUTO, attempt: { version: '0.2.1', checkedAt: CHECKED, startedAt: NOW - 60_000 }, failure: { version: '0.2.1', at: NOW - 50_000, reason: 'x' } }
  expect(decide({ auto: tried })).toEqual({ apply: false, reason: 'tried' })
  expect(decide({ auto: tried, state: found('0.2.1', CHECKED + 86_400_000) })).toEqual({ apply: true, version: '0.2.1' })
})

let dir: string
let spawned: { argv: string[]; env: Readonly<Record<string, string | undefined>> }[]
let logs: string[]
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-auto-'))
  spawned = []
  logs = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const install = (record: InstallRecord = RECORD): void => writeFileSync(join(dir, 'install.json'), JSON.stringify(record))
const deps = (change: Partial<AutoUpdateDeps> = {}): AutoUpdateDeps => ({
  dataDir: dir,
  version: '0.2.0',
  program: '/data/bin/kinfold',
  os: 'macos',
  now: () => NOW,
  envVars: () => ({ PATH: '/usr/bin' }),
  log: (line) => logs.push(line),
  lastEventAt: () => NOW - QUIET_MS,
  spawn: (argv, env) => {
    spawned.push({ argv, env })
    return 4242
  },
  exists: () => false,
  ...change,
})

test('a tick records the attempt, then starts the detached updater with the data folder', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  expect(runAutoUpdateTick(deps())).toBe('started')
  expect(spawned).toEqual([{ argv: ['/data/bin/kinfold', '--data-dir', dir, 'update', '--auto'], env: { PATH: '/usr/bin' } }])
  expect(readAutoState(dir).attempt).toEqual({ version: '0.2.1', checkedAt: CHECKED, startedAt: NOW })
  expect(logs.join('\n')).toContain('0.2.1')
})

test('the next tick, and a daemon that restarted, do not start it again for the same check', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  expect(runAutoUpdateTick(deps())).toBe('started')
  expect(runAutoUpdateTick(deps())).toBe('tried')
  // A restarted daemon has only the files to go by.
  expect(runAutoUpdateTick(deps({ lastEventAt: () => NOW - 2 * QUIET_MS }))).toBe('tried')
  expect(spawned).toHaveLength(1)
})

test('nothing is started, and nothing recorded, while agents are active or the setting is off', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  expect(runAutoUpdateTick(deps({ lastEventAt: () => NOW - 1000 }))).toBe('busy')
  install({ ...RECORD, autoUpdate: false })
  expect(runAutoUpdateTick(deps())).toBe('off')
  expect(spawned).toHaveLength(0)
  expect(readAutoState(dir).attempt).toBeNull()
})

test('a held lock means an update is running', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  acquireUpdateLock(dir)
  expect(runAutoUpdateTick(deps())).toBe('running')
  expect(spawned).toHaveLength(0)
})

test('where no detached run can be promised, the failure is recorded and nothing is started', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  const exists = (path: string): boolean => path === '/run/user/1000/systemd/private'
  expect(runAutoUpdateTick(deps({ os: 'linux', envVars: () => ({ XDG_RUNTIME_DIR: '/run/user/1000' }), exists }))).toBe('failed')
  expect(spawned).toHaveLength(0)
  expect(readAutoState(dir).failure).toEqual({ version: '0.2.1', at: NOW, reason: 'systemd-run is not installed, so an update started by the service would be stopped with it', blocked: true, running: '0.2.0' })
  expect(runAutoUpdateTick(deps({ os: 'linux', envVars: () => ({ XDG_RUNTIME_DIR: '/run/user/1000' }), exists }))).toBe('tried')
})

test('an updater that cannot be started is a recorded failure, not a crash', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  const spawn = (): number => {
    throw Object.assign(new Error('spawn /data/bin/kinfold ENOENT with a path in it'), { name: 'SpawnError' })
  }
  expect(runAutoUpdateTick(deps({ spawn }))).toBe('failed')
  expect(readAutoState(dir).failure).toEqual({ version: '0.2.1', at: NOW, reason: 'could not start the updater (SpawnError)' })
})

test('an earlier failure is cleared when a new attempt starts', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  mergeAutoState(dir, { attempt: { version: '0.2.1', checkedAt: CHECKED - 86_400_000, startedAt: 1 }, failure: { version: '0.2.1', at: 2, reason: 'old' } })
  expect(runAutoUpdateTick(deps())).toBe('started')
  expect(readAutoState(dir).failure).toBeNull()
})

test('a tick never throws: a broken dependency is logged by name', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  const now = (): number => {
    throw new TypeError('clock')
  }
  expect(runAutoUpdateTick(deps({ now }))).toBe('failed')
  expect(logs.at(-1)).toBe('auto-update failed (TypeError)')
})

test('startAutoUpdates ticks until stopped', async () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  const running = startAutoUpdates(deps(), 5)
  await Bun.sleep(40)
  running.stop()
  const count = spawned.length
  expect(count).toBe(1)
  await Bun.sleep(20)
  expect(spawned).toHaveLength(count)
})

// ---- a blocker is recorded once, and a state file that cannot be written backs off ----

const BLOCKED: AutoUpdateState = { attempt: { version: '0.2.1', checkedAt: CHECKED, startedAt: NOW - 100 }, failure: { version: '0.2.1', at: NOW - 100, reason: 'no way to detach here', blocked: true, running: '0.2.0' }, updated: null }
const nextDay = found('0.2.1', CHECKED + 86_400_000)

test('a blocker is not tried again at the next daily check', () => {
  expect(decide({ auto: BLOCKED, state: nextDay, since: NOW - 1000 })).toEqual({ apply: false, reason: 'blocked' })
  // An ordinary failure is: that is the daily retry.
  expect(decide({ auto: { ...BLOCKED, failure: { version: '0.2.1', at: NOW - 100, reason: 'download failed' } }, state: nextDay, since: NOW - 1000 })).toEqual({ apply: true, version: '0.2.1' })
})

test('a blocker is tried again once the daemon, the install or the version has changed', () => {
  // The daemon was restarted, as a service that now runs it would have done.
  expect(decide({ auto: BLOCKED, state: nextDay, since: NOW - 50 })).toEqual({ apply: true, version: '0.2.1' })
  // install.json was written after the blocker was recorded.
  expect(decide({ auto: BLOCKED, state: nextDay, since: NOW - 1000, recordChangedAt: NOW - 10 })).toEqual({ apply: true, version: '0.2.1' })
  expect(decide({ auto: BLOCKED, state: nextDay, since: NOW - 1000, recordChangedAt: NOW - 500 })).toEqual({ apply: false, reason: 'blocked' })
  expect(decide({ auto: { ...BLOCKED, failure: { ...BLOCKED.failure!, running: '0.1.9' } }, state: nextDay, since: NOW - 1000 })).toEqual({ apply: true, version: '0.2.1' })
})

test('where no detached run can be promised the reason is recorded once, not every day', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  const linux = { os: 'linux' as const, envVars: () => ({ XDG_RUNTIME_DIR: '/run/user/1000' }), exists: (path: string): boolean => path === '/run/user/1000/systemd/private', recordChangedAt: () => NOW - 5000 }
  const tick = createAutoUpdateTicker(deps(linux))
  expect(tick()).toBe('failed')
  expect(readAutoState(dir).failure).toMatchObject({ blocked: true, running: '0.2.0', at: NOW })
  writeUpdateState(dir, found('0.2.1', CHECKED + 86_400_000))
  let later = NOW + 86_400_000
  const nextTick = createAutoUpdateTicker(deps({ ...linux, now: () => later }), NOW - 1)
  expect(nextTick()).toBe('blocked')
  later += 86_400_000
  writeUpdateState(dir, found('0.2.1', CHECKED + 2 * 86_400_000))
  expect(nextTick()).toBe('blocked')
  expect(readAutoState(dir).failure?.at).toBe(NOW)
  expect(logs.filter((line) => line.includes('not started'))).toHaveLength(1)
})

test('an updater that cannot be started is an ordinary failure, tried again a day later', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  const spawn = (): number => {
    throw Object.assign(new Error('x'), { name: 'SpawnError' })
  }
  expect(runAutoUpdateTick(deps({ spawn }))).toBe('failed')
  expect(readAutoState(dir).failure?.blocked).toBeUndefined()
})

test('a state file that cannot be written is logged once, and the tick backs off for an hour', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  // A folder where the file belongs: every write of auto-update.json fails.
  mkdirSync(join(dir, 'auto-update.json'))
  let now = NOW
  const tick = createAutoUpdateTicker(deps({ now: () => now }))
  expect(tick()).toBe('failed')
  expect(spawned).toHaveLength(0)
  for (let minute = 1; minute < 60; minute += 1) {
    now = NOW + minute * 60_000
    expect(tick()).toBe('paused')
  }
  now = NOW + ERROR_BACKOFF_MS
  expect(tick()).toBe('failed')
  expect(logs.filter((line) => line.startsWith('auto-update failed'))).toHaveLength(1)
  expect(logs[0]).toContain('trying again in an hour')
  expect(ERROR_BACKOFF_MS).toBe(3_600_000)
})

test('the tick recovers once the state file can be written again, and a new error is logged again', () => {
  install()
  writeUpdateState(dir, found('0.2.1'))
  mkdirSync(join(dir, 'auto-update.json'))
  let now = NOW
  const tick = createAutoUpdateTicker(deps({ now: () => now }))
  expect(tick()).toBe('failed')
  rmSync(join(dir, 'auto-update.json'), { recursive: true })
  now = NOW + ERROR_BACKOFF_MS
  expect(tick()).toBe('started')
  expect(spawned).toHaveLength(1)
})
