import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_SECRETS } from '../../../../test/fixtures/secrets'
import { captureEvent } from '../../../resources/capture/capture'
import { type NormalizedEvent, SCHEMA_VERSION } from '../../../system/contract/event'
import { ulid } from '../../../system/contract/ulid'
import type { ContextRequest } from '../../../resources/context/types'
import { createNonceCache } from '../../central/auth'
import { loadOrCreateKey, pairWithHub } from '../../central/client'
import { type HubRoute, type HubServerDeps, type RunningHub, startHubServer } from '../../central/hub-server'
import { createInvite } from '../../central/invites'
import { newKeyPair } from '../../central/keys'
import { type Relay, type RelayDeps, VIEW_TIMEOUT_MS, createRelay, failureReason } from '../../central/relay'
import type { TailscaleIdentity } from '../../central/tailscale'
import { listEntries } from '../../../resources/spool/spool'

const hubKey = newKeyPair()
const me: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nME', nodeName: 'me', tags: [] }

let hubDir: string
let devDir: string
let hub: RunningHub | null
let port: number
let calls: { path: string; body: any }[]
let answers: Record<string, (body: any) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>>
let relay: Relay
let relayDeps: () => RelayDeps
let hubVersion: string

function startHub(atPort = 0): void {
  const routes: Record<string, HubRoute> = {}
  for (const path of ['/central/capture', '/central/context', '/central/read', '/central/view', '/central/mcp-read', '/central/semantic', '/central/hello']) {
    routes[path] = { cap: 4 * 1024 * 1024, handle: async (body) => {
      calls.push({ path, body })
      return answers[path]?.(body) ?? { status: 200, body: {} }
    } }
  }
  const deps: HubServerDeps = {
    dataDir: hubDir, version: hubVersion, hubName: 'mini', hubPrivateKey: hubKey.privateKey, hubPublicKey: hubKey.publicKey,
    auth: { dataDir: hubDir, hub: () => ({ ...me, nodeId: 'nHUB' }), whois: async () => me, now: Date.now, nonces: createNonceCache() },
    routes, log: () => {},
  }
  hub = startHubServer({ ...deps, hostname: '127.0.0.1', port: atPort, allowLoopback: true })
  port = hub.port
}

beforeEach(async () => {
  hubDir = mkdtempSync(join(tmpdir(), 'kinfold-relay-hub-'))
  devDir = mkdtempSync(join(tmpdir(), 'kinfold-relay-dev-'))
  calls = []
  answers = {}
  hubVersion = '0.6.1'
  startHub()
  const paired = await pairWithHub({ dataDir: devDir, hub: '127.0.0.1', port, code: createInvite(hubDir, Date.now()), deviceName: 'laptop', version: '0.6.0' })
  if (!paired.ok) throw new Error(paired.error)
  const endpoint = { hub: '127.0.0.1', port, hubPublicKey: paired.value.hubPublicKey, deviceId: paired.value.deviceId, privateKey: loadOrCreateKey(devDir, 'device-key.pem'), version: '0.6.0' }
  relayDeps = () => ({
    spoolDir: join(devDir, 'spool'),
    endpoint: () => ({ ...endpoint, port }),
    hubName: 'mini',
    projectKeyFor: (cwd: string) => (cwd.startsWith('/work/app') ? { key: 'github.com/acme/app', kind: 'git-remote' as const, displayName: 'app' } : { key: cwd, kind: 'path' as const, displayName: 'scratch' }),
    prepare: () => ({ hmacKey: 'device-key' }),
    log: () => {},
  })
  relay = createRelay(relayDeps())
})
afterEach(async () => {
  await hub?.stop()
  for (const dir of [hubDir, devDir]) if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

let clock = 1_792_841_878_000
function spool(overrides: Partial<NormalizedEvent> = {}): void {
  clock += 1
  const event: NormalizedEvent = { schemaVersion: SCHEMA_VERSION, eventId: ulid(clock), host: 'claude-code', hostSessionId: 's-1', kind: 'session_start', occurredAt: clock, cwd: '/work/app', ...overrides }
  captureEvent(event, { spoolDir: join(devDir, 'spool'), hmacKey: 'device-key' })
}
const spooled = (): string[] => readdirSync(join(devDir, 'spool')).filter((name) => name.endsWith('.json'))
const deviceId = (): string => calls[0]?.body?.events?.[0]?.project?.key?.split(':')[0] ?? ''

test('spooled events go to the hub with the keys this device resolved, and leave the spool once stored', async () => {
  spool()
  spool({ cwd: '/home/me/scratch', kind: 'turn_end', transcriptPath: '/home/me/.claude/x.jsonl', assistantText: 'ok' })
  answers['/central/capture'] = (body) => ({ status: 200, body: { stored: body.events.length, duplicates: 0 } })
  expect(await relay.forward()).toEqual({ sent: 2, failure: null })
  const events = calls[0]!.body.events
  expect(events[0].project).toEqual({ key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' })
  expect(events[1].project.key).toMatch(/^dev-[A-Za-z0-9_-]+:\/home\/me\/scratch$/)
  expect(events[1].event.transcriptPath).toBeUndefined()
  expect(spooled()).toEqual([])
  expect(relay.state()).toMatchObject({ reachable: true, failure: null, queued: 0 })
})

test('while the hub is down, captures stay queued, and they are sent once it is back', async () => {
  await hub!.stop()
  spool()
  spool()
  expect(await relay.forward()).toMatchObject({ sent: 0, failure: 'unreachable' })
  expect(spooled()).toHaveLength(2)
  expect(relay.state()).toMatchObject({ reachable: false, failure: 'unreachable', queued: 2 })
  startHub(port)
  answers['/central/capture'] = () => ({ status: 200, body: { stored: 2, duplicates: 0 } })
  expect(await relay.forward()).toEqual({ sent: 2, failure: null })
  expect(spooled()).toEqual([])
})

test('an event the hub rejects is set aside in quarantine, and the rest leaves the spool', async () => {
  spool()
  spool()
  answers['/central/capture'] = (body) => ({ status: 200, body: { stored: 1, duplicates: 0, rejected: [body.events[1].event.eventId] } })
  expect(await relay.forward()).toEqual({ sent: 1, failure: null })
  expect(spooled()).toEqual([])
  expect(readdirSync(join(devDir, 'spool', 'quarantine'))).toHaveLength(1)
})

test('batches are cut by their size in bytes, so text of many-byte characters cannot pass the hub cap', async () => {
  const small = createRelay({ ...relayDeps(), batchBytes: 6_000 })
  // About 2,000 characters but about 6,000 bytes each: two fit by characters, one by bytes.
  spool({ kind: 'user_prompt', promptText: '漢'.repeat(2_000) })
  spool({ kind: 'user_prompt', promptText: '字'.repeat(2_000) })
  answers['/central/capture'] = (body) => ({ status: 200, body: { stored: body.events.length, duplicates: 0, rejected: [] } })
  expect(await small.forward()).toEqual({ sent: 2, failure: null })
  expect(calls.filter((call) => call.path === '/central/capture').map((call) => call.body.events.length)).toEqual([1, 1])
})

test('a batch the hub refuses stays queued', async () => {
  spool()
  answers['/central/capture'] = () => ({ status: 400, body: { error: 'no' } })
  expect(await relay.forward()).toMatchObject({ sent: 0, failure: 'refused' })
  expect(spooled()).toHaveLength(1)
})

const prompt = (text: string, cwd = '/work/app'): ContextRequest => ({ host: 'claude-code', cwd, hostSessionId: 's-1', channel: 'prompt', prompt: text })

test('recall asks the hub for the resolved project, with the prompt redacted on this device first', async () => {
  answers['/central/context'] = () => ({ status: 200, body: { text: '<kinfold>x</kinfold>', observationIds: [9], tokens: 3 } })
  const answer = await relay.context(prompt(`deploy with ${FAKE_SECRETS.aws} please`))
  expect(answer).toMatchObject({ text: '<kinfold>x</kinfold>', observationIds: [9] })
  const sent = calls.find((call) => call.path === '/central/context')!.body
  expect(sent.project).toEqual({ key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' })
  // What the device still waits once its own share and the tailnet trip are taken out.
  expect(sent.budgetMs).toBeGreaterThan(50)
  expect(sent.budgetMs).toBeLessThan(150)
  expect(sent.request.prompt).not.toContain(FAKE_SECRETS.aws)
  expect(sent.request.prompt).toContain('<redacted')
})

test('an unreachable hub answers at once with the saved-prompt line and no memory', async () => {
  await hub!.stop()
  const startedAt = performance.now()
  const answer = await relay.context(prompt('hi'))
  expect(performance.now() - startedAt).toBeLessThan(500)
  expect(answer).toEqual({ text: '', observationIds: [], tokens: 0, display: { unavailable: "kinfold · central memory unreachable; this prompt is saved and will be sent when it's back" } })
  const start = await relay.context({ ...prompt('hi'), channel: 'session_start', prompt: undefined } as ContextRequest)
  expect(start.display?.unavailable).toBe("kinfold · central memory unreachable; this session is saved and will be sent when it's back")
})

test('a slow hub is given up on inside the hook\'s wait', async () => {
  answers['/central/context'] = async () => {
    await Bun.sleep(600)
    return { status: 200, body: { text: 'late', observationIds: [], tokens: 0 } }
  }
  const startedAt = performance.now()
  const answer = await relay.context(prompt('hi'))
  // The hook waits 200 ms for its daemon; the relay must have answered inside that.
  expect(performance.now() - startedAt).toBeLessThan(200)
  expect(answer.display?.unavailable).toBe("kinfold · mini is busy and didn't answer in time; this prompt is saved and will be sent when it answers")
})

test('a version gap is said with the side to update', async () => {
  await hub!.stop()
  hubVersion = '0.7.0'
  startHub(port)
  const answer = await relay.context(prompt('hi'))
  expect(answer.display?.unavailable).toBe('kinfold · central memory unavailable: the hub runs Kinfold 0.7.0 and this device 0.6.0; update this device (kinfold update)')
  spool()
  expect(await relay.forward()).toMatchObject({ sent: 0, failure: 'version' })
  expect(relay.state().gap).toEqual({ older: 'device', hub: '0.7.0', device: '0.6.0' })
})

test('MCP reads go to the hub with the scope this device resolved, and a string query is redacted first', async () => {
  answers['/central/read'] = () => ({ status: 200, body: { outcome: { result: { content: [], structuredContent: {} }, count: 0 } } })
  const answer = await relay.read('search', { query: `find ${FAKE_SECRETS.aws}`, limit: 3 }, '/home/me/scratch')
  expect(answer.status).toBe(200)
  const sent = calls.find((call) => call.path === '/central/read')!.body
  expect(sent.tool).toBe('search')
  expect(sent.projectKey).toMatch(/^dev-[A-Za-z0-9_-]+:\/home\/me\/scratch$/)
  expect(sent.args.limit).toBe(3)
  expect(sent.args.query).not.toContain(FAKE_SECRETS.aws)
  expect((await relay.read('search', {}, null)).status).toBe(200)
  expect(calls.at(-1)!.body.projectKey).toBeNull()
})

test('an MCP read while the hub is down answers with an unavailable outcome naming the hub', async () => {
  await hub!.stop()
  const answer = await relay.read('search', { query: 'x' }, '/work/app')
  expect(answer.status).toBe(200)
  const outcome = (answer.body as { outcome: { result: { content: { text: string }[] }; count: number } }).outcome
  expect(outcome.count).toBe(0)
  expect(outcome.result.content[0]!.text).toBe('central memory is unreachable: could not reach the hub mini')
})

test('dashboard views come from the hub, and come back marked with its name', async () => {
  answers['/central/view'] = (body) => ({ status: 200, body: { path: body.path } })
  expect(await relay.view('/memory/observations?limit=5')).toEqual({ status: 200, body: { path: '/memory/observations?limit=5' } })
  await hub!.stop()
  expect(await relay.view('/memory/observations')).toEqual({ status: 503, body: { error: 'central memory unreachable: could not reach the hub mini', central: { hub: 'mini', reachable: false } } })
})

test('a timeout says the hub is busy; only no answer at all says it cannot be reached', () => {
  expect(failureReason('timeout', 'mini', null)).toBe("mini is busy and didn't answer in time")
  expect(failureReason('unreachable', 'mini', null)).toBe('could not reach the hub mini')
  expect(failureReason('refused', 'mini', null)).toContain('mini refused this device')
})

test('a dashboard view gets a longer wait than a recall, since a page can take seconds on a large hub', () => {
  expect(VIEW_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
})

test('a view that times out once is asked again quietly, and the device stays marked as connected', async () => {
  relay = createRelay({ ...relayDeps(), viewTimeoutMs: 150 })
  await relay.hello()
  let asked = 0
  answers['/central/view'] = async (body) => {
    asked += 1
    if (asked === 1) await Bun.sleep(400)
    return { status: 200, body: { path: body.path } }
  }
  expect(await relay.view('/memory/overview')).toEqual({ status: 200, body: { path: '/memory/overview' } })
  expect(asked).toBe(2)
  expect(relay.state()).toMatchObject({ reachable: true, failure: null })
})

test('a view that times out twice says the hub is busy, never that it cannot be reached', async () => {
  relay = createRelay({ ...relayDeps(), viewTimeoutMs: 100 })
  answers['/central/view'] = async () => {
    await Bun.sleep(300)
    return { status: 200, body: {} }
  }
  expect(await relay.view('/memory/overview')).toEqual({
    status: 503, body: { error: "central memory busy: mini is busy and didn't answer in time", central: { hub: 'mini', reachable: true, busy: true } },
  })
  expect(relay.state()).toMatchObject({ failure: 'timeout' })
})

test('the device id in scoped keys is this device\'s', async () => {
  spool({ cwd: '/home/me/scratch' })
  answers['/central/capture'] = () => ({ status: 200, body: { stored: 1, duplicates: 0 } })
  await relay.forward()
  expect(deviceId()).toMatch(/^dev-/)
})

test('a backlog is listed once and looked at once more for arrivals, sent in order, and what did not fit one request leads the next', async () => {
  let listings = 0
  const counting = createRelay({ ...relayDeps(), batchBytes: 3_000, listSpool: (dir) => ((listings += 1), listEntries(dir)) })
  for (let index = 0; index < 12; index += 1) spool({ kind: 'user_prompt', promptText: `prompt ${index} ${'x'.repeat(600)}` })
  answers['/central/capture'] = (body) => ({ status: 200, body: { stored: body.events.length, duplicates: 0, rejected: [] } })
  expect(await counting.forward()).toEqual({ sent: 12, failure: null })
  const sent = calls.filter((call) => call.path === '/central/capture').flatMap((call) => call.body.events.map((item: { event: { promptText: string } }) => item.event.promptText.split(' ')[1]))
  expect(sent).toEqual(Array.from({ length: 12 }, (_, index) => String(index)))
  expect(calls.filter((call) => call.path === '/central/capture').length).toBeGreaterThan(2)
  // One listing for the twelve, whatever the number of requests, and one more at the end that found nothing new.
  expect(listings).toBe(2)
  expect(spooled()).toEqual([])
})

test('an event spooled while a forward is under way goes out with that forward', async () => {
  spool({ kind: 'user_prompt', promptText: 'first' })
  let late = false
  answers['/central/capture'] = (body) => {
    // Captured while the hub is answering: its nudge would find this forward already running.
    if (!late) {
      late = true
      spool({ kind: 'user_prompt', promptText: 'second' })
    }
    return { status: 200, body: { stored: body.events.length, duplicates: 0, rejected: [] } }
  }
  expect(await relay.forward()).toEqual({ sent: 2, failure: null })
  expect(spooled()).toEqual([])
})
