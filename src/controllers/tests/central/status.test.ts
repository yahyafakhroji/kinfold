import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureEvent } from '../../../resources/capture/capture'
import { SCHEMA_VERSION } from '../../../system/contract/event'
import { ulid } from '../../../system/contract/ulid'
import { type RunningDaemon, startDaemon } from '../../daemon/daemon'
import { type InstallRecord, setCentralMode, writeInstallRecord } from '../../../resources/install-plan/setup/record'
import { loadOrCreateKey } from '../../central/client'
import { addDevice } from '../../central/devices'
import { centralStatusLines, reachText } from '../../central/status'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1 }
let dir: string
let daemon: RunningDaemon | null
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'kinfold-central-status-')), 'data')
  mkdirSync(dir, { recursive: true })
  writeInstallRecord(dir, RECORD)
  daemon = null
})
afterEach(async () => {
  await daemon?.stop()
  const root = join(dir, '..')
  if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

const env = () => ({ dataDir: dir, fetch: (url: string, init?: RequestInit) => fetch(url, init) })

test('a local install says its memory is its own', async () => {
  expect(await centralStatusLines(env())).toEqual(['memory: local (this machine\'s own)'])
})

test('a hub says where it listens and how many devices are paired', async () => {
  setCentralMode(dir, { role: 'hub', port: 37_812 })
  expect(await centralStatusLines(env())).toEqual(['memory: hub (the daemon is not running, so devices cannot reach it)'])
  addDevice(dir, { id: 'dev-1', name: 'laptop', publicKey: 'P', nodeId: 'n', userId: '1', pairedAt: 1 })
  const tailscale = { self: async () => ({ identity: { userId: '1', loginName: '', nodeId: 'nH', nodeName: 'mini', tags: [] }, addresses: ['127.0.0.1'], dnsName: '' }), whois: async () => null }
  daemon = startDaemon({ dataDir: dir, port: 0, fallbackDrainMs: 60_000, log: () => {}, central: { mode: { role: 'hub', port: 0 }, tailscale, allowLoopback: true } })
  await daemon.central.hub!.ready
  const lines = await centralStatusLines(env())
  expect(lines[0]).toMatch(/^memory: hub for 1 paired device, listening on 127\.0\.0\.1:\d+ \(Tailscale only\)$/)
})

test('a device names its hub, says when it cannot be reached and how much is waiting, and where the observer runs', async () => {
  const mode = { role: 'device' as const, hub: '127.0.0.1', port: 1_025, hubName: 'mini', hubPublicKey: `${'A'.repeat(59)}=`, deviceId: 'dev-a', joinedAt: 1 }
  setCentralMode(dir, mode)
  loadOrCreateKey(dir, 'device-key.pem')
  captureEvent({ schemaVersion: SCHEMA_VERSION, eventId: ulid(1_792_841_878_000), host: 'claude-code', hostSessionId: 's', kind: 'session_start', occurredAt: 1_792_841_878_000, cwd: '/w' }, { spoolDir: join(dir, 'spool'), hmacKey: 'k' })
  daemon = startDaemon({ dataDir: dir, port: 0, fallbackDrainMs: 60_000, log: () => {}, central: { mode } })
  expect(await centralStatusLines(env())).toEqual([
    'memory: central, on mini (127.0.0.1:1025); not reachable: could not reach the hub mini',
    'central queue: 1 capture waiting for mini; it is sent when the hub is back',
    'observer: runs on mini, with the hub\'s settings for each agent',
  ])
})

test('the reach part of the line tells a busy hub from one that cannot be reached and from a refusal', () => {
  const base = { reachable: true, failure: null, problem: null }
  expect(reachText(base)).toBe('reachable')
  expect(reachText({ reachable: false, failure: 'timeout', problem: "mini is busy and didn't answer in time" })).toBe("busy: mini is busy and didn't answer in time; it is asked again")
  expect(reachText({ reachable: false, failure: 'unreachable', problem: 'could not reach the hub mini' })).toBe('not reachable: could not reach the hub mini')
  expect(reachText({ reachable: false, failure: 'refused', problem: 'mini refused this device' })).toBe('refused: mini refused this device')
  expect(reachText({ reachable: true, failure: 'version', problem: 'update this device' })).toBe('refused: update this device')
  expect(reachText({ reachable: true, failure: 'hub-error', problem: 'mini had an error answering (its daemon log says why)' })).toBe('error: mini had an error answering (its daemon log says why)')
  expect(reachText({ reachable: true, failure: 'bad-answer', problem: 'mini sent an answer Kinfold cannot read' })).toBe('error: mini sent an answer Kinfold cannot read')
  // A daemon from before failure was sent.
  expect(reachText({ reachable: null, problem: null })).toBe('not reachable: not asked yet')
})
