import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNonceCache } from './auth'
import { type HubEndpoint, callHub, hostPart, loadOrCreateKey, pairWithHub } from './client'
import { removeDevice } from './devices'
import { type HubServerDeps, type RunningHub, startHubServer } from './hub-server'
import { createInvite } from './invites'
import { newKeyPair } from './keys'
import type { TailscaleIdentity } from './tailscale'

const hubKey = newKeyPair()
const me: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nME', nodeName: 'me', tags: [] }

let dir: string
let deviceDir: string
let hub: RunningHub
let deps: HubServerDeps
let identity: TailscaleIdentity | null

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-central-client-hub-'))
  deviceDir = mkdtempSync(join(tmpdir(), 'kinfold-central-client-dev-'))
  identity = me
  deps = {
    dataDir: dir, version: '0.6.1', hubName: 'mini', hubPrivateKey: hubKey.privateKey, hubPublicKey: hubKey.publicKey,
    auth: { dataDir: dir, hub: () => ({ ...me, nodeId: 'nHUB' }), whois: async () => identity, now: Date.now, nonces: createNonceCache() },
    routes: {
      '/central/hello': { handle: (body) => ({ status: 200, body: { echo: body } }) },
      '/central/slow': { handle: async () => {
        await Bun.sleep(300)
        return { status: 200, body: {} }
      } },
    },
    log: () => {},
  }
  hub = startHubServer({ ...deps, hostname: '127.0.0.1', port: 0, allowLoopback: true })
})
afterEach(async () => {
  await hub.stop()
  for (const path of [dir, deviceDir]) if (path.startsWith(tmpdir())) rmSync(path, { recursive: true, force: true })
})

async function paired(version = '0.6.0'): Promise<HubEndpoint> {
  const code = createInvite(dir, Date.now())
  const result = await pairWithHub({ dataDir: deviceDir, hub: '127.0.0.1', port: hub.port, code, deviceName: 'laptop', version })
  if (!result.ok) throw new Error(result.error)
  return { hub: '127.0.0.1', port: hub.port, hubPublicKey: result.value.hubPublicKey, deviceId: result.value.deviceId, privateKey: loadOrCreateKey(deviceDir, 'device-key.pem'), version }
}

test('pairing with the code gives the hub key and name and keeps the device key owner-only', async () => {
  const code = createInvite(dir, Date.now())
  const result = await pairWithHub({ dataDir: deviceDir, hub: '127.0.0.1', port: hub.port, code: code.toLowerCase(), deviceName: 'laptop', version: '0.6.0' })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.value).toMatchObject({ hubPublicKey: hubKey.publicKey, hubName: 'mini', version: '0.6.1' })
  expect(result.value.deviceId).toMatch(/^dev-[A-Za-z0-9_-]{10,}$/)
  if (process.platform !== 'win32') expect(statSync(join(deviceDir, 'central', 'device-key.pem')).mode & 0o777).toBe(0o600)
})

test('pairing with a wrong or malformed code says so', async () => {
  createInvite(dir, Date.now())
  const wrong = await pairWithHub({ dataDir: deviceDir, hub: '127.0.0.1', port: hub.port, code: 'KF-0000-0000', deviceName: 'laptop', version: '0.6.0' })
  expect(wrong).toEqual({ ok: false, error: 'the hub refused the code: wrong code' })
  const malformed = await pairWithHub({ dataDir: deviceDir, hub: '127.0.0.1', port: hub.port, code: 'hello', deviceName: 'laptop', version: '0.6.0' })
  expect(malformed).toEqual({ ok: false, error: 'that is not a Kinfold code; it looks like KF-XXXX-XXXX' })
})

test('pairing with nothing listening says the hub cannot be reached', async () => {
  await hub.stop()
  const result = await pairWithHub({ dataDir: deviceDir, hub: '127.0.0.1', port: hub.port, code: 'KF-0000-0000', deviceName: 'laptop', version: '0.6.0' })
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain('could not reach the hub at 127.0.0.1:')
})

test('a hub that answers the pairing without proving the code is not trusted', async () => {
  const impostor = newKeyPair()
  const fake = async (url: string): Promise<Response> => url.endsWith('/central/pair/start')
    ? Response.json({ salt: Buffer.alloc(16).toString('base64'), hubName: 'mini', version: '0.6.1' })
    : Response.json({ hubPublicKey: impostor.publicKey, hubName: 'mini', hubProof: Buffer.alloc(32).toString('base64'), version: '0.6.1' })
  const result = await pairWithHub({ dataDir: deviceDir, hub: '127.0.0.1', port: 1, code: 'KF-0000-0000', deviceName: 'laptop', version: '0.6.0', fetch: fake })
  expect(result).toEqual({ ok: false, error: 'the hub could not prove it knows the code; nothing was saved' })
})

test('a signed call is answered and the answer verified', async () => {
  const endpoint = await paired()
  expect(await callHub(endpoint, '/central/hello', { a: 1 })).toEqual({ ok: true, status: 200, body: { echo: { a: 1 } } })
})

test('an answer not signed by the paired hub key is refused', async () => {
  const endpoint = await paired()
  const result = await callHub({ ...endpoint, hubPublicKey: newKeyPair().publicKey }, '/central/hello', {})
  expect(result).toMatchObject({ ok: false, reason: 'bad-signature' })
})

test('a removed device learns it is no longer paired', async () => {
  const endpoint = await paired()
  removeDevice(dir, endpoint.deviceId)
  expect(await callHub(endpoint, '/central/hello', {})).toMatchObject({ ok: false, reason: 'unpaired' })
})

test('a call from a node the hub does not accept is refused', async () => {
  const endpoint = await paired()
  identity = { ...me, userId: '77' }
  expect(await callHub(endpoint, '/central/hello', {})).toMatchObject({ ok: false, reason: 'refused' })
})

test('a version gap names the side to update', async () => {
  const endpoint = await paired()
  const result = await callHub({ ...endpoint, version: '0.5.0' }, '/central/hello', {})
  expect(result).toMatchObject({ ok: false, reason: 'version', gap: { older: 'device', hub: '0.6.1', device: '0.5.0' } })
})

test('a slow hub is given up on at the deadline, and a stopped one reads as unreachable', async () => {
  const endpoint = await paired()
  expect(await callHub(endpoint, '/central/slow', {}, { timeoutMs: 50 })).toMatchObject({ ok: false, reason: 'timeout' })
  await hub.stop()
  expect(await callHub(endpoint, '/central/hello', {})).toMatchObject({ ok: false, reason: 'unreachable' })
})

test('an unsigned error from the hub reads as a hub error or a too-large body, never as a forged answer', async () => {
  const endpoint = await paired()
  expect(await callHub(endpoint, '/central/hello', {}, { fetch: async () => new Response('{"error":"internal error"}', { status: 500 }) })).toMatchObject({ ok: false, reason: 'hub-error' })
  expect(await callHub(endpoint, '/central/hello', {}, { fetch: async () => new Response('{"error":"body too large"}', { status: 413 }) })).toMatchObject({ ok: false, reason: 'too-large' })
  expect(await callHub(endpoint, '/central/hello', {}, { fetch: async () => new Response('{}', { status: 200 }) })).toMatchObject({ ok: false, reason: 'bad-signature' })
})

test('an answer past the size cap is dropped while it is read, not after', async () => {
  const endpoint = await paired()
  let pulled = 0
  const endless = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      pulled += 1
      controller.enqueue(new Uint8Array(1024 * 1024))
    },
  })
  expect(await callHub(endpoint, '/central/hello', {}, { fetch: async () => new Response(endless, { status: 200 }) })).toMatchObject({ ok: false, reason: 'bad-answer' })
  expect(pulled).toBeLessThan(40)
})

test('IPv6 addresses are bracketed in the URL', () => {
  expect(hostPart('fd7a:115c:a1e0::1')).toBe('[fd7a:115c:a1e0::1]')
  expect(hostPart('100.64.0.1')).toBe('100.64.0.1')
  expect(hostPart('mini.tail1234.ts.net')).toBe('mini.tail1234.ts.net')
})
