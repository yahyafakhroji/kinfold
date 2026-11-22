// What counts as an agent being active, and who may use up the dashboard's
// once-only banner. Through the real server, with the clock and spawn injected.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import type { InstallRecord } from '../install/setup/record'
import { type TempStore, openTempStore } from '../observer/test-support'
import { QUIET_MS } from '../update/auto'
import { mergeAutoState } from '../update/auto-state'
import { writeUpdateState } from '../update/state'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1 }
const T0 = 1_792_900_000_000

let temp: TempStore
let rig: DashboardRig | null
let clock: number
let spawned: string[][]

beforeEach(() => {
  temp = openTempStore('kinfold-daemon-activity-')
  rig = null
  clock = T0
  spawned = []
  writeFileSync(join(temp.dataDir, 'install.json'), JSON.stringify(RECORD))
})
afterEach(async () => {
  await rig?.stop()
  temp.cleanup()
})

function start(): DashboardRig {
  rig = startRig(temp.dataDir, {
    version: '0.2.0',
    updateCheck: { fetch: () => new Promise<Response>(() => undefined), now: () => clock, envVars: () => ({}) },
    autoUpdate: { program: '/data/bin/kinfold', os: 'macos', tickMs: 5, spawn: (argv) => (spawned.push(argv), 4242) },
  })
  return rig
}

const pending = (): void => writeUpdateState(temp.dataDir, { lastAttemptAt: T0, latestVersion: '0.2.1', checkedAt: T0, notified: {} })

/** The request arrives just before the quiet spell would end; then time passes beyond what the start alone would need. */
async function stillHeldAfter(request: (r: DashboardRig) => Promise<Response>): Promise<boolean> {
  pending()
  const r = start()
  clock = T0 + QUIET_MS - 1000
  await request(r)
  clock = T0 + QUIET_MS + 5000
  await Bun.sleep(40)
  return spawned.length === 0
}

test('an MCP read counts as activity', async () => {
  expect(await stillHeldAfter((r) => r.bearer('POST', '/read/search', { query: 'x', cwd: temp.root }))).toBe(true)
})

test('an MCP read report counts as activity', async () => {
  expect(await stillHeldAfter((r) => r.bearer('POST', '/metrics/mcp-read', {}))).toBe(true)
})

test('using the dashboard counts as activity', async () => {
  expect(await stillHeldAfter(async (r) => r.page('GET', '/memory/facets', { cookie: await r.login() }))).toBe(true)
})

test('opening the dashboard login page counts as activity', async () => {
  expect(await stillHeldAfter((r) => r.page('GET', '/dashboard/login', { bare: true }))).toBe(true)
})

test('asking about updates, or for health, is not activity: the updater and the service ask those', async () => {
  pending()
  const r = start()
  clock = T0 + QUIET_MS - 1000
  expect(await (await r.bearer('GET', '/update/quiet')).json()).toEqual({ quietForMs: QUIET_MS - 1000 })
  await r.bearer('GET', '/update')
  await r.bearer('GET', '/update/auto')
  await fetch(r.url('/health'))
  // A request that is refused says nothing about an agent being at work.
  await fetch(r.url('/sessions'))
  clock = T0 + QUIET_MS + 5000
  await Bun.sleep(40)
  expect(spawned).toHaveLength(1)
})

test('kinfold status and install reading the observer settings with the token is not activity', async () => {
  pending()
  const r = start()
  clock = T0 + QUIET_MS - 1000
  expect((await r.bearer('GET', '/observer/settings')).status).toBe(200)
  clock = T0 + QUIET_MS + 5000
  await Bun.sleep(40)
  expect(spawned).toHaveLength(1)
})

test('the dashboard reading the observer settings is still activity, and so is a change through the token', async () => {
  expect(await stillHeldAfter(async (r) => r.page('GET', '/observer/settings', { cookie: await r.login() }))).toBe(true)
  await rig?.stop()
  expect(await stillHeldAfter((r) => r.bearer('PUT', '/observer/settings', { host: 'claude-code', provider: 'off' }))).toBe(true)
})

test('the quiet query needs the daemon token', async () => {
  const r = start()
  expect((await fetch(r.url('/update/quiet'))).status).toBe(401)
  expect((await r.page('GET', '/update/quiet', { cookie: await r.login() })).status).toBe(401)
  expect((await r.bearer('POST', '/update/quiet')).status).toBe(405)
})

test('only the dashboard session uses up the once-only banner; the token can read it any number of times', async () => {
  mergeAutoState(temp.dataDir, { updated: { version: '0.2.0', previous: '0.1.9', at: T0 } })
  const r = start()
  const message = 'Kinfold updated itself to 0.2.0 (was 0.1.9).'
  for (let read = 0; read < 3; read += 1) expect(await (await r.bearer('GET', '/update')).json()).toMatchObject({ notice: { message } })
  const cookie = await r.login()
  expect(await (await r.page('GET', '/update', { cookie })).json()).toMatchObject({ notice: { message } })
  expect(await (await r.page('GET', '/update', { cookie })).json()).toMatchObject({ notice: null })
  expect(await (await r.bearer('GET', '/update')).json()).toMatchObject({ notice: null })
})

test('kinfold watch --debug polling is not activity, and needs the daemon token', async () => {
  pending()
  const r = start()
  clock = T0 + QUIET_MS - 1000
  expect((await r.bearer('GET', '/watch/debug')).status).toBe(200)
  expect((await r.bearer('GET', '/watch/debug?after=0')).status).toBe(200)
  expect((await fetch(r.url('/watch/debug'))).status).toBe(401)
  clock = T0 + QUIET_MS + 5000
  await Bun.sleep(40)
  expect(spawned).toHaveLength(1)
})
