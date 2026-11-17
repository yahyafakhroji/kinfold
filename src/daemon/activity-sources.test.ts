import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { AUTO_STATE_FILE } from '../update/auto-state'
import { openStore } from '../store/db'

let root: string
let dataDir: string
let rig: DashboardRig | null = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-activity-sources-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
})
afterEach(async () => {
  await rig?.stop()
  rig = null
  rmSync(root, { recursive: true, force: true })
})

async function activity(kind: string): Promise<{ kind: string; detail: string | null; at: number }[]> {
  const response = await rig!.bearer('GET', `/memory/list/activity?kind=${kind}`)
  return ((await response.json()) as { rows: { kind: string; detail: string | null; at: number }[] }).rows
}

test('a backup the browser received in full is logged as activity', async () => {
  rig = startRig(dataDir)
  const response = await rig.bearer('GET', '/backup')
  expect(response.status).toBe(200)
  await response.arrayBuffer()
  await Bun.sleep(20)
  expect(await activity('backup')).toEqual([expect.objectContaining({ kind: 'backup' })])
})

test('an update the updater recorded is logged once, however often the daemon starts', async () => {
  writeFileSync(join(dataDir, AUTO_STATE_FILE), JSON.stringify({ attempt: null, failure: null, updated: { version: '0.6.1', previous: '0.6.0', at: 5_000 } }))
  rig = startRig(dataDir)
  expect(await activity('update-installed')).toEqual([expect.objectContaining({ detail: '0.6.1', at: 5_000 })])
  await rig.stop()
  rig = startRig(dataDir)
  expect(await activity('update-installed')).toHaveLength(1)
})

test('a browser signing in is logged as activity', async () => {
  rig = startRig(dataDir)
  await rig.login()
  expect(await activity('sign-in')).toEqual([expect.objectContaining({ kind: 'sign-in' })])
})

test('the daemon log downloads for a signed-in page as plain text, its newest 2 MB only', async () => {
  mkdirSync(join(dataDir, 'logs'), { recursive: true })
  writeFileSync(join(dataDir, 'logs', 'daemon.log'), `${'old line\n'.repeat(300_000)}newest line\n`)
  rig = startRig(dataDir)
  expect((await rig.page('GET', '/dashboard/daemon-log')).status).toBe(401)
  expect((await rig.bearer('GET', '/dashboard/daemon-log')).status).toBe(401)
  const cookie = await rig.login()
  const response = await rig.page('GET', '/dashboard/daemon-log', { cookie })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="kinfold-daemon.log"')
  const text = await response.text()
  expect(text.endsWith('newest line\n')).toBe(true)
  expect(text.length).toBeLessThanOrEqual(2 * 1024 * 1024)
})

test('with no daemon log yet the download says so', async () => {
  rig = startRig(dataDir)
  const cookie = await rig.login()
  expect((await rig.page('GET', '/dashboard/daemon-log', { cookie })).status).toBe(404)
})

test('a central device keeps its own sign-ins in memory, apart from the hub\'s activity, and writes nothing to its kept store', async () => {
  rig = startRig(dataDir, { central: { mode: { role: 'device', hub: '127.0.0.1', port: 9, hubName: 'mini', hubPublicKey: 'unused', deviceId: 'dev-test01', joinedAt: 1 } } })
  const cookie = await rig.login()
  const response = await rig.page('GET', '/dashboard/device-activity', { cookie })
  expect(response.status).toBe(200)
  expect(((await response.json()) as { rows: { kind: string }[] }).rows.map((row) => row.kind)).toEqual(['sign-in'])
  const store = openStore(dataDir)
  try {
    expect(store.db.query('SELECT count(*) AS n FROM activity').get()).toEqual({ n: 0 })
  } finally {
    store.db.close()
  }
})

test('a daemon that is not a device has no device activity of its own to show', async () => {
  rig = startRig(dataDir)
  const cookie = await rig.login()
  expect(await (await rig.page('GET', '/dashboard/device-activity', { cookie })).json()).toEqual({ rows: [] })
})
