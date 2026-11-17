import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEADER, createNonceCache, signedHeaders } from './auth'
import { deviceProof, proofKey, verifierFor, verifyHubProof } from './code'
import { findDevice, listDevices } from './devices'
import { type HubServerDeps, MAX_BATCH_BYTES, bindAddress, handleHubRequest, startHubServer } from './hub-server'
import { createInvite } from './invites'
import { bodyHash, newKeyPair, verifyReply } from './keys'
import type { TailscaleIdentity } from './tailscale'
import { readJsonFile } from './paths'

const hubKey = newKeyPair()
const device = newKeyPair()
const hubId: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nHUB', nodeName: 'mini', tags: [] }
const laptop: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nLAPTOP', nodeName: 'laptop', tags: [] }
const stranger: TailscaleIdentity = { userId: '77', loginName: 'them', nodeId: 'nTHEM', nodeName: 'them', tags: [] }

let dir: string
let deps: HubServerDeps
let captured: unknown[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-hub-server-'))
  captured = []
  deps = {
    dataDir: dir,
    version: '0.6.1',
    hubName: 'mini',
    hubPrivateKey: hubKey.privateKey,
    hubPublicKey: hubKey.publicKey,
    auth: {
      dataDir: dir,
      hub: () => hubId,
      whois: async (address) => ({ '100.64.0.5': laptop, '100.64.0.9': stranger } as Record<string, TailscaleIdentity>)[address] ?? null,
      now: Date.now,
      nonces: createNonceCache(),
    },
    routes: {
      '/central/capture': { cap: MAX_BATCH_BYTES, handle: (body) => {
        captured.push(body)
        return { status: 200, body: { accepted: 1 } }
      } },
      '/central/hello': { handle: (_body, context) => ({ status: 200, body: { device: context.deviceId } }) },
    },
    log: () => {},
  }
})
afterEach(() => {
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

async function pair(address = '100.64.0.5', code?: string, version = '0.6.0') {
  const live = code ?? createInvite(dir, Date.now())
  const invite = readJsonFile(join(dir, 'central', 'invites.json')) as { salt: string }
  const key = proofKey(verifierFor(live, invite.salt))
  const fields = { deviceId: 'dev-1', devicePublicKey: device.publicKey, nonce: 'pair-nonce-0000001' }
  const body = JSON.stringify({ ...fields, deviceName: 'laptop', proof: deviceProof(key, fields), version })
  const response = await handleHubRequest(new Request('http://hub/central/pair', { method: 'POST', body }), address, deps)
  return { response, key, fields }
}

function signed(path: string, payload: unknown, options: { version?: string; address?: string } = {}) {
  const body = JSON.stringify(payload)
  const headers = signedHeaders({ privateKey: device.privateKey, deviceId: 'dev-1', method: 'POST', path, body, version: options.version ?? '0.6.0' })
  return { request: new Request(`http://hub${path}`, { method: 'POST', body, headers }), address: options.address ?? '100.64.0.5', signature: headers[HEADER.signature]! }
}

test('pairing with the code stores the device, bound to its node, and proves the hub', async () => {
  const { response, key, fields } = await pair()
  expect(response.status).toBe(200)
  const answer = await response.json() as { hubPublicKey: string; hubName: string; hubProof: string; version: string }
  expect(answer).toMatchObject({ hubPublicKey: hubKey.publicKey, hubName: 'mini', version: '0.6.1' })
  expect(verifyHubProof(key, { hubPublicKey: answer.hubPublicKey, devicePublicKey: fields.devicePublicKey, nonce: fields.nonce }, answer.hubProof)).toBe(true)
  expect(findDevice(dir, 'dev-1')).toMatchObject({ name: 'laptop', publicKey: device.publicKey, nodeId: 'nLAPTOP', userId: '42' })
})

test('a pairing is reported by device id for the Activity page', async () => {
  const paired: string[] = []
  deps = { ...deps, onPaired: (id) => paired.push(id) }
  expect((await pair()).response.status).toBe(200)
  expect(paired).toEqual(['dev-1'])
})

test('a wrong code counts a try and pairs nothing', async () => {
  createInvite(dir, Date.now())
  const { response } = await pair('100.64.0.5', 'KF-0000-0000')
  expect(response.status).toBe(403)
  expect(listDevices(dir)).toEqual([])
  expect((readJsonFile(join(dir, 'central', 'invites.json')) as { triesLeft: number }).triesLeft).toBe(4)
})

test('another Tailscale user is refused before the code is checked, so it cannot use up the tries', async () => {
  const code = createInvite(dir, Date.now())
  const { response } = await pair('100.64.0.9', code)
  expect(response.status).toBe(403)
  expect(listDevices(dir)).toEqual([])
  expect((readJsonFile(join(dir, 'central', 'invites.json')) as { triesLeft: number }).triesLeft).toBe(5)
})

test('pairing with no invite open says how to make one', async () => {
  const body = JSON.stringify({ deviceId: 'dev-1', devicePublicKey: device.publicKey, nonce: 'pair-nonce-0000001', deviceName: 'laptop', proof: 'x', version: '0.6.0' })
  const response = await handleHubRequest(new Request('http://hub/central/pair', { method: 'POST', body }), '100.64.0.5', deps)
  expect(response.status).toBe(410)
  expect(await response.json()).toEqual({ error: 'no invite is open on the hub; run kinfold central invite there' })
})

test('pairing from a different minor version is refused with the side to update', async () => {
  const { response } = await pair('100.64.0.5', undefined, '0.5.9')
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'version', hubVersion: '0.6.1' })
  expect(listDevices(dir)).toEqual([])
})

test('a pair body that is not the expected shape is refused', async () => {
  createInvite(dir, Date.now())
  for (const body of ['nope', '{}', JSON.stringify({ deviceId: '../x', devicePublicKey: device.publicKey, nonce: 'pair-nonce-0000001', deviceName: 'l', proof: 'x', version: '0.6.0' })]) {
    const response = await handleHubRequest(new Request('http://hub/central/pair', { method: 'POST', body }), '100.64.0.5', deps)
    expect(response.status).toBe(400)
  }
})

test('a signed request from the paired device is answered and the answer is signed by the hub', async () => {
  await pair()
  const { request, address, signature } = signed('/central/hello', {})
  const response = await handleHubRequest(request, address, deps)
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({ device: 'dev-1' })
  const replySignature = response.headers.get(HEADER.reply) ?? ''
  expect(verifyReply(hubKey.publicKey, { requestSignature: signature, status: 200, bodySha256: bodyHash(text) }, replySignature)).toBe(true)
  expect(response.headers.get(HEADER.version)).toBe('0.6.1')
})

test('an unsigned request, or one from another node, is refused', async () => {
  await pair()
  const plain = await handleHubRequest(new Request('http://hub/central/hello', { method: 'POST', body: '{}' }), '100.64.0.5', deps)
  expect(plain.status).toBe(401)
  const { request } = signed('/central/hello', {}, { address: '100.64.0.9' })
  expect((await handleHubRequest(request, '100.64.0.9', deps)).status).toBe(403)
})

test('only the listed routes exist; everything that changes stored memory is absent', async () => {
  await pair()
  for (const path of ['/central/purge', '/data/purge', '/backup', '/restore', '/observer/settings', '/central/forget', '/central/retention']) {
    const { request, address } = signed(path, {})
    expect((await handleHubRequest(request, address, deps)).status).toBe(404)
  }
  const get = await handleHubRequest(new Request('http://hub/central/hello'), '100.64.0.5', deps)
  expect(get.status).toBe(405)
})

test('a device on another minor version gets 409 naming the hub version', async () => {
  await pair()
  const { request, address } = signed('/central/hello', {}, { version: '0.7.0' })
  const response = await handleHubRequest(request, address, deps)
  expect(response.status).toBe(409)
  expect(await response.json()).toMatchObject({ error: 'version', hubVersion: '0.6.1' })
})

test('bodies past 16 KB are refused, except the capture batch which has its own cap', async () => {
  await pair()
  const big = { text: 'x'.repeat(20_000) }
  const hello = signed('/central/hello', big)
  expect((await handleHubRequest(hello.request, hello.address, deps)).status).toBe(413)
  const capture = signed('/central/capture', big)
  expect((await handleHubRequest(capture.request, capture.address, deps)).status).toBe(200)
  expect(captured).toHaveLength(1)
  const huge = signed('/central/capture', { text: 'x'.repeat(MAX_BATCH_BYTES) })
  expect((await handleHubRequest(huge.request, huge.address, deps)).status).toBe(413)
})

test('the listener binds only a Tailscale address; loopback only when a test asks for it', () => {
  expect(bindAddress(['100.101.102.103', 'fd7a:115c:a1e0::1'], false)).toBe('100.101.102.103')
  expect(() => bindAddress([], false)).toThrow('Tailscale')
  expect(() => bindAddress(['0.0.0.0'], false)).toThrow('Tailscale')
  expect(() => bindAddress(['127.0.0.1'], false)).toThrow('Tailscale')
  expect(() => bindAddress(['192.168.1.4'], true)).toThrow('Tailscale')
  expect(bindAddress(['127.0.0.1'], true)).toBe('127.0.0.1')
})

test('a started listener answers on its address and stops', async () => {
  const server = startHubServer({ ...deps, hostname: '127.0.0.1', port: 0, allowLoopback: true })
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/central/hello`, { method: 'POST', body: '{}' })
    expect(response.status).toBe(401)
  } finally {
    await server.stop()
  }
  expect(() => startHubServer({ ...deps, hostname: '0.0.0.0', port: 0 })).toThrow('Tailscale')
})

test('pair start hands the open invite\'s salt to a node of the hub\'s user, and to nobody else', async () => {
  createInvite(dir, Date.now())
  const salt = (readJsonFile(join(dir, 'central', 'invites.json')) as { salt: string }).salt
  const mine = await handleHubRequest(new Request('http://hub/central/pair/start', { method: 'POST', body: '{}' }), '100.64.0.5', deps)
  expect(mine.status).toBe(200)
  expect(await mine.json()).toEqual({ salt, hubName: 'mini', version: '0.6.1' })
  const theirs = await handleHubRequest(new Request('http://hub/central/pair/start', { method: 'POST', body: '{}' }), '100.64.0.9', deps)
  expect(theirs.status).toBe(403)
  rmSync(join(dir, 'central', 'invites.json'))
  expect((await handleHubRequest(new Request('http://hub/central/pair/start', { method: 'POST', body: '{}' }), '100.64.0.5', deps)).status).toBe(410)
})

test('a sender outside Tailscale\'s ranges is refused before any lookup', async () => {
  let looked = 0
  const counting = { ...deps, auth: { ...deps.auth, whois: async (address: string) => { looked += 1; return deps.auth.whois(address) } } }
  createInvite(dir, Date.now())
  for (const path of ['/central/pair/start', '/central/pair', '/central/hello']) {
    const response = await handleHubRequest(new Request(`http://hub${path}`, { method: 'POST', body: '{}' }), '192.168.1.5', counting)
    expect(response.status).toBe(403)
  }
  expect(looked).toBe(0)
})

test('a device id that is already paired cannot be paired again over it', async () => {
  await pair()
  const second = await pair()
  expect(second.response.status).toBe(409)
  expect(await second.response.json()).toEqual({ error: 'that device id is already paired; try joining again' })
  expect(listDevices(dir)).toHaveLength(1)
})

test('a stranger learns nothing about the hub\'s version from a pairing attempt', async () => {
  createInvite(dir, Date.now())
  const { response } = await pair('100.64.0.9', undefined, '0.0.1')
  expect(response.status).toBe(403)
  expect(JSON.stringify(await response.json())).not.toContain('0.6.1')
})
