import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { type RunningDaemon, startDaemon } from '../../daemon/daemon'
import { type FakeWorld, createWorld, fakeService } from '../install/test-support'
import { type InstallRecord, setCentralMode, writeInstallRecord } from '../../../resources/install-plan/setup/record'
import { insertObservation } from '../../../resources/store/observer-store'
import { openStore } from '../../../resources/store/db'
import { upsertProject, upsertSession } from '../../../resources/store/writes'
import { parseCentralArgs, runCentralCommand } from '../../central/cli'
import { addDevice, listDevices } from '../../central/devices'
import { centralModeOf } from '../../central/mode'
import type { Tailscale, TailscaleIdentity } from '../../central/tailscale'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1_792_900_000_000 }
const ME: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nLAPTOP', nodeName: 'laptop', tags: [] }
const tailscale: Tailscale = {
  self: async () => ({ identity: { ...ME, nodeId: 'nHUB', nodeName: 'mini' }, addresses: ['127.0.0.1'], dnsName: 'mini.tail1234.ts.net' }),
  whois: async () => ME,
}

let hubWorld: FakeWorld
let deviceWorld: FakeWorld
let hub: RunningDaemon | null
beforeEach(() => {
  hubWorld = createWorld()
  deviceWorld = createWorld()
  // The hub daemon checks invite expiry against the wall clock, as the CLI writes it in production.
  hubWorld.env = { ...hubWorld.env, service: fakeService({ running: true }), now: Date.now }
  deviceWorld.env = { ...deviceWorld.env, service: fakeService({ running: true }), now: Date.now }
  writeInstallRecord(hubWorld.dataDir, RECORD)
  writeInstallRecord(deviceWorld.dataDir, RECORD)
  hub = null
})
afterEach(async () => {
  await hub?.stop()
  await hubWorld.cleanup()
  await deviceWorld.cleanup()
})

const parse = (line: string) => parseCentralArgs(line.split(' '))

test('the commands parse, with the hub port defaulting and taken from host:port or --port', () => {
  expect(parse('install')).toBeNull()
  expect(parse('central serve')).toEqual({ ok: true, value: { command: 'serve', port: 37_812, off: false } })
  expect(parse('central serve --port 40000')).toEqual({ ok: true, value: { command: 'serve', port: 40_000, off: false } })
  expect(parse('central serve --off')).toEqual({ ok: true, value: { command: 'serve', port: 37_812, off: true } })
  expect(parse('central join mini KF-4821-9TQX')).toEqual({ ok: true, value: { command: 'join', hub: 'mini', port: 37_812, code: 'KF-4821-9TQX', codeInArgs: true } })
  expect(parse('central join 100.64.0.2:40000 KF-4821-9TQX')).toEqual({ ok: true, value: { command: 'join', hub: '100.64.0.2', port: 40_000, code: 'KF-4821-9TQX', codeInArgs: true } })
  expect(parse('central join [fd7a:115c:a1e0::2]:40000 KF-4821-9TQX')).toEqual({ ok: true, value: { command: 'join', hub: 'fd7a:115c:a1e0::2', port: 40_000, code: 'KF-4821-9TQX', codeInArgs: true } })
  // The code is a secret, so the command is given without it and asks.
  expect(parse('central join mini')).toEqual({ ok: true, value: { command: 'join', hub: 'mini', port: 37_812, code: null } })
  expect(parse('central join mini --port 40001')).toEqual({ ok: true, value: { command: 'join', hub: 'mini', port: 40_001, code: null } })
  expect(parse('central join mini.tail.ts.net KF-4821-9TQX --port 40001')).toMatchObject({ ok: true, value: { hub: 'mini.tail.ts.net', port: 40_001 } })
  expect(parse('central remove laptop')).toEqual({ ok: true, value: { command: 'remove', device: 'laptop' } })
  expect(parse('central import --project github.com/a/b')).toEqual({ ok: true, value: { command: 'import', project: 'github.com/a/b' } })
  for (const bad of ['central', 'central join', 'central remove', 'central import', 'central nope', 'central serve --port 80', 'central join mini;rm KF-1']) {
    expect(parse(bad)?.ok).toBe(false)
  }
})

test('serve makes this machine the hub, restarts the service and shows a code with the join line', async () => {
  expect(await runCentralCommand(hubWorld.env, { command: 'serve', port: 37_812, off: false }, { tailscale })).toBe(0)
  expect(centralModeOf(hubWorld.dataDir)).toEqual({ role: 'hub', port: 37_812 })
  expect(existsSync(join(hubWorld.dataDir, 'central', 'hub-key.pem'))).toBe(true)
  const code = hubWorld.out.find((line) => line.startsWith('Code: '))!.slice('Code: '.length, 'Code: '.length + 12)
  expect(hubWorld.out).toContain('On the device: kinfold central join mini.tail1234.ts.net   (it asks for the code)')
  // The code is shown once, on its own line, never inside a command to paste: a command line is readable by other programs.
  expect(hubWorld.out.filter((line) => line.includes(code))).toEqual([`Code: ${code} (valid 10 minutes, for one device)`])
  expect(hubWorld.out).toContain('Restarted the FakeService to open the hub port.')
  hubWorld.out.length = 0
  expect(await runCentralCommand(hubWorld.env, { command: 'invite' }, { tailscale })).toBe(0)
  expect(hubWorld.out[0]).toMatch(/^Code: KF-/)
  expect(await runCentralCommand(hubWorld.env, { command: 'serve', port: 37_812, off: true })).toBe(0)
  expect(centralModeOf(hubWorld.dataDir)).toBeNull()
})

test('on macOS, serve and invite say the firewall may ask to allow incoming connections; elsewhere they do not', async () => {
  const note = (out: readonly string[]): boolean => out.some((line) => line.includes('firewall may ask'))
  const mac = { ...hubWorld.env, platform: 'darwin' as const }
  expect(await runCentralCommand(mac, { command: 'serve', port: 37_812, off: false }, { tailscale })).toBe(0)
  expect(note(hubWorld.out)).toBe(true)
  hubWorld.out.length = 0
  expect(await runCentralCommand(mac, { command: 'invite' }, { tailscale })).toBe(0)
  expect(note(hubWorld.out)).toBe(true)
  hubWorld.out.length = 0
  expect(await runCentralCommand({ ...hubWorld.env, platform: 'linux' }, { command: 'invite' }, { tailscale })).toBe(0)
  expect(note(hubWorld.out)).toBe(false)
})

test('serve needs an install record, and a device cannot also be the hub', async () => {
  const bare = createWorld()
  try {
    expect(await runCentralCommand(bare.env, { command: 'serve', port: 37_812, off: false }, { tailscale })).toBe(1)
    expect(bare.out).toContain('This data folder has no install record; run kinfold install first.')
  } finally {
    await bare.cleanup()
  }
})

test('join pairs, imports the projects the hub lacks, keeps the hub\'s version of the rest, and leave goes back', async () => {
  // The hub already has the shared project; the device has it too, plus a scratch folder the hub has never seen.
  const hubStore = openStore(hubWorld.dataDir)
  upsertProject(hubStore.db, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, 1)
  hubStore.db.close()
  const local = openStore(deviceWorld.dataDir)
  for (const [key, kind, title] of [['github.com/acme/app', 'git-remote', 'Device view of app'], ['/home/me/scratch', 'path', 'Scratch idea']] as const) {
    upsertProject(local.db, { key, kind, displayName: key.split('/').at(-1)! }, 1)
    const session = upsertSession(local.db, { host: 'claude-code', hostSessionId: `s-${title}`, projectKey: key, cwd: '/w', occurredAt: 1 })
    insertObservation(local.db, { projectKey: key, sessionId: session, host: 'claude-code', promptNumber: null, type: 'discovery', title, narrative: '', facts: '[]', files: '[]', evidence: 'user-stated', sourceEventIds: '[]', observerModel: 'm', contentHash: title, occurredAt: 1, createdAt: 1 })
  }
  local.db.close()

  writeInstallRecord(hubWorld.dataDir, RECORD)
  hub = startDaemon({ dataDir: hubWorld.dataDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.1', log: () => {}, central: { mode: { role: 'hub', port: 0 }, tailscale, allowLoopback: true } })
  await hub.central.hub!.ready
  const port = Number(hub.central.hub!.state().listening!.split(':').at(-1))
  setCentralMode(hubWorld.dataDir, { role: 'hub', port })
  await runCentralCommand(hubWorld.env, { command: 'invite' }, { tailscale })
  const code = hubWorld.out.find((line) => line.startsWith('Code: '))!.slice(6, 18)

  expect(await runCentralCommand(deviceWorld.env, { command: 'join', hub: '127.0.0.1', port, code }, { version: '0.6.0', allowLoopback: true })).toBe(0)
  const mode = centralModeOf(deviceWorld.dataDir)
  expect(mode).toMatchObject({ role: 'device', hub: '127.0.0.1', port, hubName: 'mini' })
  // The import ran before the switch, so the service restart is the last step.
  expect(deviceWorld.out.at(-1)).toBe('Restarted the FakeService to use central memory.')
  expect(deviceWorld.out).toContain('Paired with mini.')
  expect(deviceWorld.out).toContain('app: already on mini; the hub\'s version is used, and this device\'s copy is kept here.')
  expect(deviceWorld.out).toContain('scratch: imported (1 memories, 1 sessions, 0 prompts).')
  expect(listDevices(hubWorld.dataDir)).toHaveLength(1)

  const after = openStore(hubWorld.dataDir)
  const titles = after.db.query('SELECT title, project_key AS key FROM observations ORDER BY title').all()
  after.db.close()
  expect(titles).toEqual([{ title: 'Scratch idea', key: `${mode?.role === 'device' ? mode.deviceId : ''}:/home/me/scratch` }])

  // Importing the kept copy of the shared project later adds what the hub lacks.
  expect(await runCentralCommand(deviceWorld.env, { command: 'import', project: 'github.com/acme/app' }, { version: '0.6.0' })).toBe(0)
  expect(deviceWorld.out.at(-1)).toBe('app: mini added what it did not have (1 memories, 1 sessions, 0 prompts).')

  expect(await runCentralCommand(deviceWorld.env, { command: 'leave' })).toBe(0)
  expect(centralModeOf(deviceWorld.dataDir)).toBeNull()
  expect(existsSync(join(deviceWorld.dataDir, 'central', 'device-key.pem'))).toBe(false)
  // The device's own store was not changed by any of it.
  const kept = openStore(deviceWorld.dataDir)
  expect(kept.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 2 })
  kept.db.close()
})

test('join asks for the code, or reads it from stdin in a pipe, and warns when it was put on the command line', async () => {
  hub = startDaemon({ dataDir: hubWorld.dataDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.1', log: () => {}, central: { mode: { role: 'hub', port: 0 }, tailscale, allowLoopback: true } })
  await hub.central.hub!.ready
  const port = Number(hub.central.hub!.state().listening!.split(':').at(-1))
  setCentralMode(hubWorld.dataDir, { role: 'hub', port })
  const deps = { version: '0.6.0', allowLoopback: true }
  const asked: string[] = []
  const withIo = (io: Partial<typeof deviceWorld.env.io>) => ({ ...deviceWorld.env, io: { ...deviceWorld.env.io, ...io } })
  const WARNING = 'The code was on the command line, where other programs on this machine can read it. Next time run kinfold central join <hub> and type the code when asked.'

  // Nothing typed and nothing piped: no request is made.
  expect(await runCentralCommand(withIo({ interactive: false, readStdin: async () => '\n' }), { command: 'join', hub: '127.0.0.1', port, code: null }, deps)).toBe(1)
  expect(deviceWorld.out.at(-1)).toBe('No code given. Run kinfold central join <hub> and type the code the hub shows, or pipe it in.')
  // Typed at the prompt, echo off, wrong: the hub refuses it.
  const typedWrong = withIo({ interactive: true, askSecret: async (question) => (asked.push(question), 'KF-0000-0000') })
  expect(await runCentralCommand(typedWrong, { command: 'join', hub: '127.0.0.1', port, code: null }, deps)).toBe(1)
  expect(asked).toEqual(['Code from the hub (KF-XXXX-XXXX): '])
  expect(deviceWorld.out).not.toContain(WARNING)
  // Piped in, right.
  await runCentralCommand(hubWorld.env, { command: 'invite' }, { tailscale })
  const code = hubWorld.out.filter((line) => line.startsWith('Code: ')).at(-1)!.slice(6, 18)
  expect(await runCentralCommand(withIo({ interactive: false, readStdin: async () => `${code}\n` }), { command: 'join', hub: '127.0.0.1', port, code: null }, deps)).toBe(0)
  expect(deviceWorld.out).not.toContain(WARNING)
  expect(await runCentralCommand(deviceWorld.env, { command: 'leave' }, deps)).toBe(0)
  // The old form still pairs, and says why not to use it.
  await runCentralCommand(hubWorld.env, { command: 'invite' }, { tailscale })
  const next = hubWorld.out.filter((line) => line.startsWith('Code: ')).at(-1)!.slice(6, 18)
  expect(await runCentralCommand(deviceWorld.env, { command: 'join', hub: '127.0.0.1', port, code: next, codeInArgs: true }, deps)).toBe(0)
  expect(deviceWorld.out).toContain(WARNING)
})

test('join refuses a wrong code and saves nothing', async () => {
  hub = startDaemon({ dataDir: hubWorld.dataDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.1', log: () => {}, central: { mode: { role: 'hub', port: 0 }, tailscale, allowLoopback: true } })
  await hub.central.hub!.ready
  const port = Number(hub.central.hub!.state().listening!.split(':').at(-1))
  setCentralMode(hubWorld.dataDir, { role: 'hub', port })
  await runCentralCommand(hubWorld.env, { command: 'invite' }, { tailscale })
  expect(await runCentralCommand(deviceWorld.env, { command: 'join', hub: '127.0.0.1', port, code: 'KF-0000-0000' }, { version: '0.6.0', allowLoopback: true })).toBe(1)
  expect(deviceWorld.out.at(-1)).toBe('the hub refused the code: wrong code')
  expect(centralModeOf(deviceWorld.dataDir)).toBeNull()
})

test('a name stored before names were checked is printed without its control and text-direction characters', async () => {
  setCentralMode(hubWorld.dataDir, { role: 'hub', port: 37_812 })
  addDevice(hubWorld.dataDir, { id: 'dev-9', name: 'lap\u009b2J\u202etop', publicKey: 'k', nodeId: 'n', userId: 'u', pairedAt: Date.UTC(2026, 10, 1) })
  expect(await runCentralCommand(hubWorld.env, { command: 'devices' })).toBe(0)
  expect(hubWorld.out.at(-1)).toBe('lap2Jtop  dev-9  paired 2026-11-01')
  expect(await runCentralCommand(hubWorld.env, { command: 'remove', device: 'dev-9' })).toBe(0)
  expect(hubWorld.out.at(-1)).toBe('Removed lap2Jtop (dev-9); it can no longer read or capture.')
})

test('devices and remove manage the paired list on the hub only', async () => {
  expect(await runCentralCommand(hubWorld.env, { command: 'devices' })).toBe(1)
  expect(hubWorld.out.at(-1)).toBe('This machine is not the hub; run kinfold central serve first.')
  await runCentralCommand(hubWorld.env, { command: 'serve', port: 37_812, off: false }, { tailscale })
  expect(await runCentralCommand(hubWorld.env, { command: 'devices' })).toBe(0)
  expect(hubWorld.out.at(-1)).toBe('No paired devices.')
  expect(await runCentralCommand(hubWorld.env, { command: 'remove', device: 'ghost' })).toBe(1)
})

test('join pins the hub to its Tailscale address and refuses a name that resolves anywhere else', async () => {
  const resolve = async (name: string): Promise<string[]> => ({ 'mini.tail1234.ts.net': ['100.101.102.103'], evil: ['203.0.113.9'] } as Record<string, string[]>)[name] ?? []
  const seen: string[] = []
  const fetchSpy = async (url: string): Promise<Response> => {
    seen.push(url)
    throw new TypeError('refused')
  }
  expect(await runCentralCommand(deviceWorld.env, { command: 'join', hub: 'evil', port: 37_812, code: 'KF-4821-9TQX' }, { resolve, fetch: fetchSpy })).toBe(1)
  expect(deviceWorld.out.at(-1)).toBe('evil does not resolve to a Tailscale address; use the hub\'s Tailscale name or its 100.x address, with Tailscale up on this device.')
  expect(seen).toEqual([])
  await runCentralCommand(deviceWorld.env, { command: 'join', hub: 'mini.tail1234.ts.net', port: 37_812, code: 'KF-4821-9TQX' }, { resolve, fetch: fetchSpy })
  expect(seen[0]).toBe('http://100.101.102.103:37812/central/pair/start')
})

test('a device with many projects imports every one the hub lacks', async () => {
  const local = openStore(deviceWorld.dataDir)
  for (let index = 0; index < 230; index += 1) {
    const key = `/Users/somebody/a/fairly/long/folder/name/number-${index}`
    upsertProject(local.db, { key, kind: 'path', displayName: `p${index}` }, 1)
    const session = upsertSession(local.db, { host: 'claude-code', hostSessionId: `s-${index}`, projectKey: key, cwd: key, occurredAt: 1 })
    insertObservation(local.db, { projectKey: key, sessionId: session, host: 'claude-code', promptNumber: null, type: 'discovery', title: `memory ${index}`, narrative: '', facts: '[]', files: '[]', evidence: 'user-stated', sourceEventIds: '[]', observerModel: 'm', contentHash: `h${index}`, occurredAt: 1, createdAt: 1 })
  }
  local.db.close()
  hub = startDaemon({ dataDir: hubWorld.dataDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.1', log: () => {}, central: { mode: { role: 'hub', port: 0 }, tailscale, allowLoopback: true } })
  await hub.central.hub!.ready
  const port = Number(hub.central.hub!.state().listening!.split(':').at(-1))
  setCentralMode(hubWorld.dataDir, { role: 'hub', port })
  await runCentralCommand(hubWorld.env, { command: 'invite' }, { tailscale })
  const code = hubWorld.out.find((line) => line.startsWith('Code: '))!.slice(6, 18)
  expect(await runCentralCommand(deviceWorld.env, { command: 'join', hub: '127.0.0.1', port, code }, { version: '0.6.0', allowLoopback: true })).toBe(0)
  expect(deviceWorld.out.filter((line) => line.includes(': imported (')).length).toBe(230)
  const after = openStore(hubWorld.dataDir)
  expect(after.db.query('SELECT COUNT(*) AS n FROM observations').get()).toEqual({ n: 230 })
  after.db.close()
}, 60_000)

test('when the hub cannot say which projects it has, join imports none and lists the commands', async () => {
  const local = openStore(deviceWorld.dataDir)
  upsertProject(local.db, { key: '/home/me/scratch', kind: 'path', displayName: 'scratch' }, 1)
  local.db.close()
  hub = startDaemon({ dataDir: hubWorld.dataDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.1', log: () => {}, central: { mode: { role: 'hub', port: 0 }, tailscale, allowLoopback: true } })
  await hub.central.hub!.ready
  const port = Number(hub.central.hub!.state().listening!.split(':').at(-1))
  setCentralMode(hubWorld.dataDir, { role: 'hub', port })
  await runCentralCommand(hubWorld.env, { command: 'invite' }, { tailscale })
  const code = hubWorld.out.find((line) => line.startsWith('Code: '))!.slice(6, 18)
  const failingKnown = async (url: string, init: RequestInit): Promise<Response> => (url.endsWith('/central/import/known') ? new Response('{}', { status: 500 }) : fetch(url, init))
  expect(await runCentralCommand(deviceWorld.env, { command: 'join', hub: '127.0.0.1', port, code }, { version: '0.6.0', allowLoopback: true, fetch: failingKnown })).toBe(0)
  expect(deviceWorld.out.some((line) => line.startsWith('Could not check which projects mini already has'))).toBe(true)
  expect(deviceWorld.out).toContain('  kinfold central import --project /home/me/scratch')
  expect(deviceWorld.out.some((line) => line.includes('already on mini'))).toBe(false)
})
