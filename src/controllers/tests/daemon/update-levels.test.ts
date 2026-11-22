// Releases that wait for a yes, through the real daemon and server: staging
// in the background, what GET /update offers, the updates settings and the
// dashboard's Install button. The release feed, the clock and the spawn are
// injected; nothing reaches the network or a service manager.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { RELEASE_BASE } from '../install/self-install'
import { type TempStore, openTempStore } from '../observer/test-support'
import { writeInstallRun } from '../update/install-run'
import { acquireUpdateLock } from '../update/lock'
import { stagedProgram } from '../update/stage'
import { writeUpdateState } from '../update/state'

const T0 = 1_792_900_000_000
const ASSET = 'kinfold-darwin-arm64'
const PROGRAM = new TextEncoder().encode('new program')
const SUMS = `${createHash('sha256').update(PROGRAM).digest('hex')}  ${ASSET}\n`

let temp: TempStore
let rig: DashboardRig | null
let spawned: string[][]
let routes: Record<string, () => Response>

const record = (fields: Record<string, unknown> = {}): void => {
  writeFileSync(join(temp.dataDir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, ...fields }))
}

beforeEach(() => {
  temp = openTempStore('kinfold-update-levels-')
  rig = null
  spawned = []
  routes = {
    [`${RELEASE_BASE}/v0.6.0/SHA256SUMS`]: () => new Response(SUMS),
    [`${RELEASE_BASE}/v0.6.0/${ASSET}`]: () => new Response(PROGRAM),
  }
  record()
})
afterEach(async () => {
  await rig?.stop()
  temp.cleanup()
})

function start(): DashboardRig {
  rig = startRig(temp.dataDir, {
    version: '0.5.0',
    updateCheck: {
      fetch: async (url) => routes[url]?.() ?? new Promise<Response>(() => undefined),
      now: () => T0,
      envVars: () => ({}),
    },
    autoUpdate: { program: '/data/bin/kinfold', os: 'macos', tickMs: 5, platform: 'darwin', arch: 'arm64', spawn: (argv) => (spawned.push(argv), 4242) },
  })
  return rig
}

const offer = (version: string, changes: string[] = [], breaking: string[] = []): void =>
  writeUpdateState(temp.dataDir, { lastAttemptAt: T0, latestVersion: version, checkedAt: T0, notified: {}, beta: false, release: { version, prerelease: false, changes, breaking } })

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(5)
}

test('the daemon stages a minor release in the background and never starts it', async () => {
  offer('0.6.0')
  start()
  await until(() => stagedProgram(temp.dataDir, 'darwin') !== null)
  expect(stagedProgram(temp.dataDir, 'darwin')?.version).toBe('0.6.0')
  expect(spawned).toEqual([])
})

async function staged(): Promise<DashboardRig> {
  offer('0.6.0', ['Gone.', 'New thing.'], ['Gone.'])
  const r = start()
  await until(() => stagedProgram(temp.dataDir, 'darwin') !== null)
  return r
}

test('GET /update offers the staged release with its change lines, breaking first, and the settings', async () => {
  const r = await staged()
  const body = (await (await r.page('GET', '/update', { cookie: await r.login() })).json()) as Record<string, any>
  expect(body.notice).toEqual({ version: '0.6.0', message: 'Kinfold 0.6.0 is ready · 2 changes, 1 breaking · kinfold update to install' })
  expect(body.release).toEqual({ version: '0.6.0', changes: ['Gone.', 'New thing.'], breaking: ['Gone.'], staged: true, installable: true })
  expect(body.settings).toEqual({ level: 'patch', beta: false })
  expect(body.install).toBeNull()
})

test('at notify GET /update tells the release and offers no Install button', async () => {
  record({ updates: 'notify' })
  offer('0.6.0')
  const r = start()
  const body = (await (await r.bearer('GET', '/update')).json()) as Record<string, any>
  expect(body.release).toMatchObject({ version: '0.6.0', staged: false, installable: false })
  expect(body.notice.message).toBe('Kinfold 0.6.0 is available · no changelog for this release. Run `kinfold update`.')
})

test('PUT /update/settings saves the level and beta, and refuses a body that is not one', async () => {
  const r = start()
  const cookie = await r.login()
  const saved = await r.page('PUT', '/update/settings', { cookie, body: { level: 'notify', beta: true } })
  expect(saved.status).toBe(200)
  expect(((await saved.json()) as Record<string, unknown>).settings).toEqual({ level: 'notify', beta: true })
  expect((await r.page('PUT', '/update/settings', { cookie, body: { level: 'weekly', beta: true } })).status).toBe(400)
  expect((await r.page('PUT', '/update/settings', { cookie, body: { level: 'off' } })).status).toBe(400)
  expect((await r.page('PUT', '/update/settings', { cookie, body: { level: 'off', beta: false }, bare: true })).status).toBe(403)
})

test('POST /update/install starts the staged install detached, and GET /update/install reports it', async () => {
  const r = await staged()
  const cookie = await r.login()
  const started = await r.page('POST', '/update/install', { cookie, body: { version: '0.6.0' } })
  expect(started.status).toBe(202)
  expect(spawned).toHaveLength(1)
  expect(spawned[0]).toEqual(['/data/bin/kinfold', '--data-dir', temp.dataDir, 'update', '--staged', '0.6.0'])
  const run = (await (await r.page('GET', '/update/install', { cookie })).json()) as Record<string, any>
  expect(run).toMatchObject({ running: '0.5.0', install: { version: '0.6.0', previous: '0.5.0', state: 'running' } })
  // A second press while it runs starts nothing more.
  expect((await r.page('POST', '/update/install', { cookie, body: { version: '0.6.0' } })).status).toBe(409)
  expect(spawned).toHaveLength(1)
})

test('POST /update/install refuses without a staged program, for another version, and without the page headers', async () => {
  offer('0.6.0')
  record({ updates: 'notify' })
  const r = start()
  const cookie = await r.login()
  const none = await r.page('POST', '/update/install', { cookie, body: { version: '0.6.0' } })
  expect(none.status).toBe(409)
  expect(((await none.json()) as Record<string, string>).error).toBe('no checked download of 0.6.0 is waiting; run kinfold update instead')
  expect((await r.page('POST', '/update/install', { cookie, body: { version: '0.6.0' }, bare: true })).status).toBe(403)
  expect((await r.page('POST', '/update/install', { body: { version: '0.6.0' } })).status).toBe(401)
  expect((await r.page('POST', '/update/install', { cookie, body: { version: '../x' } })).status).toBe(400)
  expect(spawned).toEqual([])
})

test('POST /update/install refuses while another update holds the lock', async () => {
  const r = await staged()
  const lock = acquireUpdateLock(temp.dataDir)
  const answer = await r.page('POST', '/update/install', { cookie: await r.login(), body: { version: '0.6.0' } })
  expect(answer.status).toBe(409)
  expect(((await answer.json()) as Record<string, string>).error).toContain('another update is running')
  expect(spawned).toEqual([])
  lock?.release()
})

test('the daemon the install restarted reports how the dashboard install ended', async () => {
  writeInstallRun(temp.dataDir, { version: '0.6.0', previous: '0.5.0', state: 'running', message: null, at: T0 })
  const first = start()
  expect(((await (await first.bearer('GET', '/update/install')).json()) as Record<string, any>).install.state).toBe('running')
  await first.stop()
  rig = null
  // The updater records the result, then the service starts the new program.
  writeInstallRun(temp.dataDir, { version: '0.6.0', previous: '0.5.0', state: 'updated', message: null, at: T0 + 1 })
  const second = startRig(temp.dataDir, { version: '0.6.0', updateCheck: { fetch: () => new Promise<Response>(() => undefined), now: () => T0, envVars: () => ({}) } })
  rig = second
  expect(await (await second.bearer('GET', '/update/install')).json()).toEqual({ running: '0.6.0', install: { version: '0.6.0', previous: '0.5.0', state: 'updated', message: null, at: T0 + 1 } })
  expect((await (await fetch(second.url('/health'))).json()) as Record<string, unknown>).toMatchObject({ version: '0.6.0' })
})

test('a dashboard session from before the install restart is still signed in after it, until sign-out', async () => {
  const first = start()
  const cookie = await first.login()
  expect((await first.page('GET', '/update/install', { cookie })).status).toBe(200)
  await first.stop()
  rig = null
  const second = startRig(temp.dataDir, { version: '0.6.0', updateCheck: { fetch: () => new Promise<Response>(() => undefined), now: () => T0, envVars: () => ({}) } })
  rig = second
  expect((await second.page('GET', '/update/install', { cookie })).status).toBe(200)
  expect((await second.page('POST', '/dashboard/logout', { cookie })).status).toBe(204)
  expect((await second.page('GET', '/update/install', { cookie })).status).toBe(401)
})
