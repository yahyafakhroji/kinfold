// A hub and a device in one test process: two throwaway data folders,
// loopback standing in for the tailnet, and the Tailscale identity check
// injected. It walks the whole life of a device: pair, capture, recall,
// a hub that goes away and comes back, a revoked device, and leaving.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHook } from '../../cli/hook'
import { seedObservation } from '../../../resources/tests/context/test-support'
import { type RunningDaemon, startDaemon } from '../../daemon/daemon'
import { openStore } from '../../../resources/store/db'
import { upsertProject, upsertSession } from '../../../resources/store/writes'
import { loadOrCreateKey, pairWithHub } from '../../central/client'
import { listDevices, removeDevice } from '../../central/devices'
import { createInvite } from '../../central/invites'
import type { CentralMode } from '../../central/mode'
import { UNREACHABLE_PROMPT_LINE } from '../../central/relay'
import type { Tailscale, TailscaleIdentity } from '../../central/tailscale'

const FIXTURES = join(import.meta.dir, '../../../../test/fixtures/claude-code')
const ME: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nLAPTOP', nodeName: 'laptop', tags: [] }
const tailscale: Tailscale = {
  self: async () => ({ identity: { ...ME, nodeId: 'nHUB', nodeName: 'mini' }, addresses: ['127.0.0.1'], dnsName: 'mini.tail.ts.net' }),
  whois: async () => ME,
}

let root: string
let hubDir: string
let devDir: string
let repo: string
let hub: RunningDaemon | null
let device: RunningDaemon | null

function git(args: string[]): void {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'ignore', stderr: 'ignore' })
  if (!result.success) throw new Error(`git ${args.join(' ')} failed`)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-two-daemons-'))
  hubDir = join(root, 'hub')
  devDir = join(root, 'device')
  repo = join(root, 'laptop-checkout', 'app')
  mkdirSync(repo, { recursive: true })
  git(['init', '-q'])
  git(['remote', 'add', 'origin', 'git@github.com:acme/app.git'])
  hub = null
  device = null
  // The hub already knows this project from its own sessions.
  const store = openStore(hubDir)
  try {
    upsertProject(store.db, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, Date.now())
    const session = upsertSession(store.db, { host: 'opencode', hostSessionId: 'oc-hub', projectKey: 'github.com/acme/app', cwd: '/Users/mini/src/app', occurredAt: Date.now() })
    seedObservation(store, { sessionId: session, projectKey: 'github.com/acme/app', host: 'opencode', title: 'Learned on the hub', at: Date.now() })
  } finally {
    store.db.close()
  }
})
afterEach(async () => {
  await device?.stop()
  await hub?.stop()
  if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true })
})

function startHub(port: number): RunningDaemon {
  return startDaemon({ dataDir: hubDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.1', log: () => {}, central: { mode: { role: 'hub', port }, tailscale, allowLoopback: true } })
}

async function hubPort(daemon: RunningDaemon): Promise<number> {
  await daemon.central.hub!.ready
  return Number(daemon.central.hub!.state().listening!.split(':').at(-1))
}

const payload = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as object), cwd: repo, ...extra })

async function hook(name: string, extra: Record<string, unknown> = {}): Promise<Record<string, any> | null> {
  const line = await runHook(payload(name, extra), devDir, () => undefined, {}, { fallback: false, budgetMs: 1_000, daemonShareMs: 900 }, 'claude-code')
  return line === null ? null : (JSON.parse(line) as Record<string, any>)
}

function hubPrompts(): { text: string; key: string }[] {
  const store = openStore(hubDir)
  try {
    return store.db.query('SELECT prompts.text AS text, sessions.project_key AS key FROM prompts JOIN sessions ON sessions.id = prompts.session_id ORDER BY prompts.id').all() as { text: string; key: string }[]
  } finally {
    store.db.close()
  }
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

const queued = (): number => readdirSync(join(devDir, 'spool')).filter((name) => name.endsWith('.json')).length

test('pair, capture, recall, offline queueing, revoke and leave, end to end', async () => {
  hub = startHub(0)
  const port = await hubPort(hub)

  // Pair.
  const paired = await pairWithHub({ dataDir: devDir, hub: '127.0.0.1', port, code: createInvite(hubDir, Date.now()), deviceName: 'laptop', version: '0.6.0' })
  if (!paired.ok) throw new Error(paired.error)
  expect(listDevices(hubDir).map((each) => each.name)).toEqual(['laptop'])
  const mode: CentralMode = { role: 'device', hub: '127.0.0.1', port, hubName: paired.value.hubName, hubPublicKey: paired.value.hubPublicKey, deviceId: paired.value.deviceId, joinedAt: Date.now() }
  loadOrCreateKey(devDir, 'device-key.pem')
  device = startDaemon({ dataDir: devDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.0', log: () => {}, central: { mode } })

  // Recall at session start comes from the hub's memory, for the project this device resolved from its own git remote.
  const start = await hook('session-start')
  expect(String(start?.hookSpecificOutput?.additionalContext)).toContain('Learned on the hub')

  // A prompt is captured on the device and stored on the hub under the shared key.
  await hook('user-prompt-submit', { prompt: 'first prompt from the laptop' })
  await until(() => hubPrompts().some((row) => row.text === 'first prompt from the laptop'), 'the prompt on the hub')
  expect(hubPrompts().find((row) => row.text === 'first prompt from the laptop')?.key).toBe('github.com/acme/app')

  // The hub goes away: the prompt is saved on the device and the user is told.
  await hub.stop()
  hub = null
  const offline = await hook('user-prompt-submit', { prompt: 'written while the hub was away' })
  expect(offline?.systemMessage).toBe(UNREACHABLE_PROMPT_LINE)
  expect(queued()).toBeGreaterThan(0)

  // It comes back on the same port, and the queue drains to it.
  hub = startHub(port)
  await hubPort(hub)
  await device.scheduler.request()
  await until(() => hubPrompts().some((row) => row.text === 'written while the hub was away'), 'the queued prompt on the hub')
  await until(() => queued() === 0, 'an empty queue')

  // Revoked on the hub: the next prompt says so, and its capture waits on the device.
  removeDevice(hubDir, 'laptop')
  const revoked = await hook('user-prompt-submit', { prompt: 'after the device was removed' })
  expect(String(revoked?.systemMessage)).toContain('no longer paired')
  await until(() => queued() > 0, 'the capture kept on the device')
  expect(hubPrompts().some((row) => row.text === 'after the device was removed')).toBe(false)

  // Leave: the device is local again, with its own store untouched; what it captured centrally stays on the hub.
  await device.stop()
  device = startDaemon({ dataDir: devDir, port: 0, fallbackDrainMs: 60_000, version: '0.6.0', log: () => {}, central: { mode: null } })
  const local = await hook('session-start')
  expect(String(local?.hookSpecificOutput?.additionalContext ?? '')).not.toContain('Learned on the hub')
  expect(hubPrompts().map((row) => row.text)).toEqual(expect.arrayContaining(['first prompt from the laptop', 'written while the hub was away']))
})
