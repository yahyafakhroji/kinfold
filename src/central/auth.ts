// Who may use the hub. A request passes only when all of these hold, checked
// cheapest first so a request that fails early costs no identity lookup:
// the signing headers are present, the device is paired, the time is within
// the window, the Ed25519 signature covers this method, path and body, the
// nonce is new, and Tailscale says the sending node is the one the device
// paired from and is owned by the hub's own user (not shared in, not tagged).

import { randomBytes } from 'node:crypto'
import { findDevice } from './devices'
import { bodyHash, signRequest, verifyRequest } from './keys'
import { type TailscaleIdentity, sameOwner } from './tailscale'

export const SKEW_MS = 2 * 60_000

export const HEADER = {
  device: 'x-kinfold-device',
  time: 'x-kinfold-time',
  nonce: 'x-kinfold-nonce',
  signature: 'x-kinfold-signature',
  version: 'x-kinfold-version',
  reply: 'x-kinfold-hub-signature',
} as const

const ID = /^[A-Za-z0-9_-]{1,64}$/
const NONCE = /^[A-Za-z0-9_-]{16,64}$/
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/

export interface NonceCache {
  /** True the first time a device uses this nonce within the window. */
  claim(deviceId: string, nonce: string): boolean
}

export function createNonceCache(now: () => number = Date.now): NonceCache {
  const seen = new Map<string, number>()
  return {
    claim: (deviceId, nonce) => {
      const at = now()
      // Anything older than both sides of the clock window could no longer pass, so it need not be remembered.
      for (const [key, until] of seen) if (until < at) seen.delete(key)
      const key = `${deviceId}\n${nonce}`
      if (seen.has(key)) return false
      seen.set(key, at + 2 * SKEW_MS)
      return true
    },
  }
}

export interface AuthDeps {
  dataDir: string
  /** The hub's own Tailscale identity; null when Tailscale is not running, which refuses everything. */
  hub: () => TailscaleIdentity | null
  whois: (address: string) => Promise<TailscaleIdentity | null>
  now: () => number
  nonces: NonceCache
}

export interface CentralRequest {
  method: string
  /** Path and query, exactly as sent. */
  path: string
  headers: Headers
  body: Uint8Array
  /** The sending node's address as the listener saw it. */
  address: string
}

export type AuthFailure = 'unsigned' | 'unpaired' | 'clock' | 'bad-signature' | 'replay' | 'identity'
export type AuthResult = { ok: true; deviceId: string; version: string } | { ok: false; status: 401 | 403; reason: AuthFailure }

const refuse = (reason: AuthFailure): AuthResult => ({ ok: false, status: reason === 'identity' ? 403 : 401, reason })

/** True when the node at `address` is the device's own node, owned by the hub's user. */
export async function sameNode(deps: Pick<AuthDeps, 'hub' | 'whois'>, address: string, expectedNodeId: string | null): Promise<TailscaleIdentity | null> {
  const hub = deps.hub()
  if (hub === null) return null
  const node = await deps.whois(address)
  if (node === null || !sameOwner(hub, node)) return null
  return expectedNodeId === null || node.nodeId === expectedNodeId ? node : null
}

export async function verifyCentralRequest(request: CentralRequest, deps: AuthDeps): Promise<AuthResult> {
  const get = (name: string): string => request.headers.get(name) ?? ''
  const deviceId = get(HEADER.device)
  const timeText = get(HEADER.time)
  const nonce = get(HEADER.nonce)
  const signature = get(HEADER.signature)
  const version = get(HEADER.version)
  if (!ID.test(deviceId) || !/^\d{13}$/.test(timeText) || !NONCE.test(nonce) || !SIGNATURE.test(signature) || !VERSION.test(version)) return refuse('unsigned')
  const device = findDevice(deps.dataDir, deviceId)
  if (device === null) return refuse('unpaired')
  const time = Number(timeText)
  if (Math.abs(deps.now() - time) > SKEW_MS) return refuse('clock')
  const signed = { method: request.method, path: request.path, deviceId, time, nonce, bodySha256: bodyHash(request.body) }
  if (!verifyRequest(device.publicKey, signed, signature)) return refuse('bad-signature')
  if (!deps.nonces.claim(deviceId, nonce)) return refuse('replay')
  if ((await sameNode(deps, request.address, device.nodeId)) === null) return refuse('identity')
  return { ok: true, deviceId, version }
}

export interface SigningInput {
  privateKey: string
  deviceId: string
  method: string
  path: string
  body: Uint8Array | string
  version: string
  time?: number
  nonce?: string
}

/** The headers a device sends; the signature is also what the hub's reply is bound to. */
export function signedHeaders(input: SigningInput): Record<string, string> {
  const time = input.time ?? Date.now()
  const nonce = input.nonce ?? randomBytes(18).toString('base64url')
  const signature = signRequest(input.privateKey, { method: input.method, path: input.path, deviceId: input.deviceId, time, nonce, bodySha256: bodyHash(input.body) })
  return {
    [HEADER.device]: input.deviceId,
    [HEADER.time]: String(time),
    [HEADER.nonce]: nonce,
    [HEADER.signature]: signature,
    [HEADER.version]: input.version,
  }
}
