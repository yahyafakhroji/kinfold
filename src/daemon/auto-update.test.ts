// The daemon's part in automatic updates, through its real server: what GET
// /update reports, the switch on PUT /update/auto, and the quiet wait before
// the detached updater starts. The spawn and the clock are injected.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { accessFor } from '../dashboard/access'
import { type InstallRecord, readInstallRecord } from '../install/setup/record'
import { type TempStore, openTempStore } from '../observer/test-support'
import { QUIET_MS } from '../update/auto'
import { mergeAutoState, readAutoState } from '../update/auto-state'
import { writeUpdateState } from '../update/state'
import { type DaemonOptions, type RunningDaemon, startDaemon } from './daemon'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1 }
const T0 = 1_792_900_000_000
const NO_AUTO_STATE = { lastError: null, lastUpdate: null }

let temp: TempStore
let daemon: RunningDaemon | null
let clock: number
let spawned: string[][]

beforeEach(() => {
  temp = openTempStore('kinfold-daemon-auto-')
  daemon = null
  clock = T0
  spawned = []
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  temp.cleanup()
})

const install = (record: InstallRecord = RECORD): void => writeFileSync(join(temp.dataDir, 'install.json'), JSON.stringify(record))
const found = (latestVersion: string): void => writeUpdateState(temp.dataDir, { lastAttemptAt: T0, latestVersion, checkedAt: T0, notified: {} })

function start(options: Partial<DaemonOptions> = {}): RunningDaemon {
  daemon = startDaemon({
    dataDir: temp.dataDir,
    port: 0,
    version: '0.2.0',
    fallbackDrainMs: 60_000,
    log: () => undefined,
    // The daily check stays out of the way: its last attempt is "now", so it is never due.
    updateCheck: { fetch: () => new Promise<Response>(() => undefined), now: () => clock, envVars: () => ({}) },
    ...options,
  })
  return daemon
}

const autoUpdate = (tickMs = 5): NonNullable<DaemonOptions['autoUpdate']> => ({
  program: '/data/bin/kinfold',
  os: 'macos',
  tickMs,
  spawn: (argv) => {
    spawned.push(argv)
    return 4242
  },
})

const token = (): string => readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
const call = (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${daemon!.port}${path}`, { method, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

test('GET /update reports that auto-update is on, or why it is off', async () => {
  start()
  expect(await (await call('GET', '/update')).json()).toEqual({ notice: null, auto: { on: false, reason: 'no install record', ...NO_AUTO_STATE }, release: null, settings: { level: 'notify', beta: false }, install: null })
  install()
  expect(await (await call('GET', '/update')).json()).toMatchObject({ notice: null, auto: { on: true, reason: null, ...NO_AUTO_STATE } })
  install({ ...RECORD, updateCheck: false })
  expect(await (await call('GET', '/update')).json()).toMatchObject({ auto: { on: false, reason: 'the update check is off' } })
})

test('GET /update shows the last error while its release is still newer, and the last update', async () => {
  install()
  found('0.2.1')
  const failure = { version: '0.2.1', at: T0 - 5, reason: 'the program download answered 503; nothing was changed' }
  const updated = { version: '0.2.0', previous: '0.1.9', at: T0 - 99 }
  mergeAutoState(temp.dataDir, { failure, updated })
  start()
  const body = (await (await call('GET', '/update')).json()) as { auto: unknown }
  expect(body.auto).toEqual({ on: true, reason: null, lastError: failure, lastUpdate: updated })
  // An error about a release that has since been installed by hand is history, not a problem.
  mergeAutoState(temp.dataDir, { failure: { ...failure, version: '0.2.0' } })
  expect(((await (await call('GET', '/update')).json()) as { auto: { lastError: unknown } }).auto.lastError).toBeNull()
})

test('PUT /update/auto turns auto-update off and on in install.json', async () => {
  install({ ...RECORD, channel: 'npx' })
  start()
  const off = await call('PUT', '/update/auto', { enabled: false })
  expect(off.status).toBe(200)
  expect(await off.json()).toEqual({ auto: { on: false, reason: 'turned off', ...NO_AUTO_STATE } })
  expect(readInstallRecord(temp.dataDir)).toMatchObject({ ...RECORD, channel: 'npx', autoUpdate: false })
  // Stamped, so an install that is running at the same moment does not write the old choice back.
  expect(readInstallRecord(temp.dataDir)?.autoUpdateAt).toBe(T0)
  expect(await (await call('PUT', '/update/auto', { enabled: true })).json()).toEqual({ auto: { on: true, reason: null, ...NO_AUTO_STATE } })
  expect(readInstallRecord(temp.dataDir)?.autoUpdate).toBe(true)
})

test('PUT /update/auto refuses a malformed body, another method, and a folder with no install record', async () => {
  start()
  expect((await call('PUT', '/update/auto', { enabled: false })).status).toBe(409)
  install()
  for (const body of [{ enabled: 'no' }, {}, [], 'x']) expect((await call('PUT', '/update/auto', body)).status).toBe(400)
  expect((await call('POST', '/update/auto', { enabled: false })).status).toBe(405)
  expect((await call('POST', '/update', {})).status).toBe(405)
  expect(readInstallRecord(temp.dataDir)?.autoUpdate).toBe(true)
  expect((await fetch(`http://127.0.0.1:${daemon!.port}/update/auto`, { method: 'PUT', body: '{"enabled":false}' })).status).toBe(401)
})

test('the dashboard may use the switch with its session cookie', () => {
  expect(accessFor('/update/auto')).toBe('either')
})

test('the updater starts only after ten minutes without an agent event', async () => {
  install()
  found('0.2.1')
  start({ autoUpdate: autoUpdate() })
  await Bun.sleep(40)
  // The daemon has just started: its start counts as activity.
  expect(spawned).toEqual([])
  clock = T0 + QUIET_MS - 1000
  expect((await call('POST', '/spool/nudge')).status).toBe(202)
  clock = T0 + QUIET_MS + 5000
  await Bun.sleep(40)
  expect(spawned).toEqual([])
  clock = T0 + 2 * QUIET_MS - 1000
  await Bun.sleep(40)
  expect(spawned).toEqual([['/data/bin/kinfold', '--data-dir', temp.dataDir, 'update', '--auto']])
  expect(readAutoState(temp.dataDir).attempt).toMatchObject({ version: '0.2.1', checkedAt: T0 })
  await Bun.sleep(30)
  expect(spawned).toHaveLength(1)
})

test('a session start counts as an agent event', async () => {
  install()
  found('0.2.1')
  start({ autoUpdate: autoUpdate() })
  clock = T0 + QUIET_MS - 1000
  expect((await call('POST', '/context', { host: 'claude-code', cwd: temp.root, hostSessionId: 's-1', channel: 'session_start' })).status).toBe(200)
  clock = T0 + QUIET_MS + 5000
  await Bun.sleep(40)
  expect(spawned).toEqual([])
})

test('a daemon that is not the installed program never starts an updater', async () => {
  install()
  found('0.2.1')
  start()
  clock = T0 + 3 * QUIET_MS
  await Bun.sleep(40)
  expect(spawned).toEqual([])
  expect(readAutoState(temp.dataDir).attempt).toBeNull()
})

test('stopping the daemon stops the tick', async () => {
  install()
  found('0.2.1')
  const running = start({ autoUpdate: autoUpdate() })
  await running.stop()
  daemon = null
  clock = T0 + 3 * QUIET_MS
  await Bun.sleep(40)
  expect(spawned).toEqual([])
})

test('GET /update/auto reads the switch without using up the once-only banner', async () => {
  install()
  mergeAutoState(temp.dataDir, { updated: { version: '0.2.0', previous: '0.1.9', at: T0 } })
  start()
  expect(await (await call('GET', '/update/auto')).json()).toEqual({ auto: { on: true, reason: null, lastError: null, lastUpdate: { version: '0.2.0', previous: '0.1.9', at: T0 } } })
  expect(await (await call('GET', '/update')).json()).toMatchObject({ notice: { message: 'Kinfold updated itself to 0.2.0 (was 0.1.9).' } })
})

test('a session start carries the self-update notice under its own key', async () => {
  install()
  mergeAutoState(temp.dataDir, { updated: { version: '0.2.0', previous: '0.1.9', at: T0 } })
  start()
  const body = (await (await call('POST', '/context', { host: 'claude-code', cwd: temp.root, hostSessionId: 's-1', channel: 'session_start' })).json()) as Record<string, unknown>
  expect(body.selfNotice).toEqual({ kind: 'updated', version: '0.2.0', previous: '0.1.9', channel: 'curl' })
  expect(body.updateNotice).toBeUndefined()
})

test('only a daemon that can update itself holds the patch notice back', async () => {
  install()
  found('0.2.1')
  start()
  expect(await (await call('GET', '/update')).json()).toMatchObject({ notice: { message: 'Kinfold 0.2.1 is available. Run `kinfold update`.' } })
  await daemon!.stop()
  start({ autoUpdate: autoUpdate(60_000) })
  expect(await (await call('GET', '/update')).json()).toMatchObject({ notice: null })
})

test('an attempt that left no result is shown as the last error', async () => {
  install()
  found('0.2.1')
  mergeAutoState(temp.dataDir, { attempt: { version: '0.2.1', checkedAt: T0, startedAt: T0 - 2 * 3_600_000 } })
  start()
  const body = (await (await call('GET', '/update/auto')).json()) as { auto: { lastError: unknown } }
  expect(body.auto.lastError).toEqual({ version: '0.2.1', at: T0 - 2 * 3_600_000, reason: 'the updater started and recorded no result; see logs/auto-update.log' })
})

test('the dashboard may set the claude-cli token, like the other observer settings', () => {
  expect(accessFor('/observer/claude-token')).toBe('either')
})
