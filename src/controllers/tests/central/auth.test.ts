import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AuthDeps, SKEW_MS, createNonceCache, signedHeaders, verifyCentralRequest } from './auth'
import { addDevice, removeDevice } from './devices'
import { newKeyPair } from './keys'
import type { TailscaleIdentity } from './tailscale'

const T0 = 1_700_000_000_000
const key = newKeyPair()
const hub: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nHUB', nodeName: 'mini', tags: [] }
const laptop: TailscaleIdentity = { userId: '42', loginName: 'me', nodeId: 'nLAPTOP', nodeName: 'laptop', tags: [] }

let dir: string
let identities: Record<string, TailscaleIdentity | null>
let whoisCalls: number
let deps: AuthDeps

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-central-auth-'))
  addDevice(dir, { id: 'dev-1', name: 'laptop', publicKey: key.publicKey, nodeId: 'nLAPTOP', userId: '42', pairedAt: T0 })
  identities = { '100.64.0.5': laptop }
  whoisCalls = 0
  deps = {
    dataDir: dir,
    hub: () => hub,
    whois: async (address) => {
      whoisCalls += 1
      return identities[address] ?? null
    },
    now: () => T0,
    nonces: createNonceCache(),
  }
})
afterEach(() => {
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

const body = new TextEncoder().encode('{"x":1}')
function request(overrides: { headers?: Record<string, string>; path?: string; method?: string; body?: Uint8Array; address?: string; nonce?: string } = {}) {
  const headers = signedHeaders({ privateKey: key.privateKey, deviceId: 'dev-1', method: 'POST', path: '/central/capture', body, time: T0, nonce: overrides.nonce ?? 'nonce-000000000001', version: '0.6.0' })
  return {
    method: overrides.method ?? 'POST',
    path: overrides.path ?? '/central/capture',
    headers: new Headers({ ...headers, ...overrides.headers }),
    body: overrides.body ?? body,
    address: overrides.address ?? '100.64.0.5',
  }
}

test('a request signed by a paired device, from its node, passes', async () => {
  const result = await verifyCentralRequest(request(), deps)
  expect(result).toEqual({ ok: true, deviceId: 'dev-1', version: '0.6.0' })
})

test('missing or malformed headers are refused before anything is looked up', async () => {
  for (const name of ['x-kinfold-device', 'x-kinfold-time', 'x-kinfold-nonce', 'x-kinfold-signature']) {
    const req = request()
    req.headers.delete(name)
    expect(await verifyCentralRequest(req, deps)).toMatchObject({ ok: false, status: 401, reason: 'unsigned' })
  }
  expect(await verifyCentralRequest(request({ headers: { 'x-kinfold-time': 'soon' } }), deps)).toMatchObject({ ok: false, reason: 'unsigned' })
  expect(whoisCalls).toBe(0)
})

test('a device that is not paired, or was removed, is refused', async () => {
  removeDevice(dir, 'dev-1')
  expect(await verifyCentralRequest(request(), deps)).toMatchObject({ ok: false, status: 401, reason: 'unpaired' })
  expect(whoisCalls).toBe(0)
})

test('a changed method, path or body breaks the signature', async () => {
  expect(await verifyCentralRequest(request({ method: 'PUT' }), deps)).toMatchObject({ ok: false, reason: 'bad-signature' })
  expect(await verifyCentralRequest(request({ path: '/central/import' }), deps)).toMatchObject({ ok: false, reason: 'bad-signature' })
  expect(await verifyCentralRequest(request({ body: new TextEncoder().encode('{"x":2}') }), deps)).toMatchObject({ ok: false, reason: 'bad-signature' })
  const other = newKeyPair()
  const forged = signedHeaders({ privateKey: other.privateKey, deviceId: 'dev-1', method: 'POST', path: '/central/capture', body, time: T0, nonce: 'nonce-000000000001', version: '0.6.0' })
  expect(await verifyCentralRequest(request({ headers: forged }), deps)).toMatchObject({ ok: false, reason: 'bad-signature' })
  expect(whoisCalls).toBe(0)
})

test('a request outside the clock window is refused', async () => {
  expect(await verifyCentralRequest(request(), { ...deps, now: () => T0 + SKEW_MS + 1 })).toMatchObject({ ok: false, reason: 'clock' })
  expect(await verifyCentralRequest(request(), { ...deps, now: () => T0 - SKEW_MS - 1 })).toMatchObject({ ok: false, reason: 'clock' })
})

test('the same signed request is accepted once', async () => {
  expect((await verifyCentralRequest(request(), deps)).ok).toBe(true)
  expect(await verifyCentralRequest(request(), deps)).toMatchObject({ ok: false, status: 401, reason: 'replay' })
})

test('a request from another user, a tagged node, another node of the same user or an unknown address is refused', async () => {
  identities['100.64.0.5'] = { ...laptop, userId: '77' }
  expect(await verifyCentralRequest(request({ nonce: 'nonce-00000000000a' }), deps)).toMatchObject({ ok: false, status: 403, reason: 'identity' })
  identities['100.64.0.5'] = { ...laptop, tags: ['tag:ci'] }
  expect(await verifyCentralRequest(request({ nonce: 'nonce-00000000000b' }), deps)).toMatchObject({ ok: false, status: 403, reason: 'identity' })
  identities['100.64.0.5'] = { ...laptop, nodeId: 'nPHONE' }
  expect(await verifyCentralRequest(request({ nonce: 'nonce-00000000000c' }), deps)).toMatchObject({ ok: false, status: 403, reason: 'identity' })
  identities['100.64.0.5'] = null
  expect(await verifyCentralRequest(request({ nonce: 'nonce-00000000000d' }), deps)).toMatchObject({ ok: false, status: 403, reason: 'identity' })
})

test('a hub whose own identity is unknown refuses everything', async () => {
  expect(await verifyCentralRequest(request(), { ...deps, hub: () => null })).toMatchObject({ ok: false, status: 403, reason: 'identity' })
})

test('the nonce cache forgets nonces once they could no longer pass the clock check', () => {
  let now = T0
  const cache = createNonceCache(() => now)
  expect(cache.claim('dev-1', 'n')).toBe(true)
  expect(cache.claim('dev-1', 'n')).toBe(false)
  expect(cache.claim('dev-2', 'n')).toBe(true)
  now = T0 + 2 * SKEW_MS + 1
  expect(cache.claim('dev-1', 'n')).toBe(true)
})
