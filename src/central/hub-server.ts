// The hub's second listener: the only Kinfold port that is not loopback. It
// binds one Tailscale address of this machine, never 0.0.0.0, loopback or a
// LAN address, so only the tailnet can reach it. Every route but pairing
// needs a signed request from a paired device on its own node (auth.ts), and
// the routes are a fixed list: nothing that changes or removes stored memory
// is on it, so a device can read and capture and nothing more. Every answer
// to a signed request is signed with the hub's key and bound to that request.
//
// Bodies are read only after the device is known, and by counting: 16 KB for
// every route but the capture batch and the import, which carry many events.

import { type AuthDeps, HEADER, sameNode, verifyCentralRequest } from './auth'
import { hubProof, proofKey, verifyDeviceProof } from './code'
import { addDevice, findDevice } from './devices'
import { pendingInvite, redeemInvite } from './invites'
import { bodyHash, signReply } from './keys'
import { isLoopbackAddress, isTailscaleAddress } from './tailscale'
import { versionGap } from './version-rule'

export const DEFAULT_HUB_PORT = 37_812
export const MAX_BODY_BYTES = 16_384
/** A capture batch or an import chunk; the relay keeps its batches well under this. */
export const MAX_BATCH_BYTES = 4 * 1024 * 1024

export interface HubAnswer {
  status: number
  body: unknown
}

export interface HubContext {
  deviceId: string
  deviceName: string
  /** The device's Kinfold version, already checked against the hub's. */
  version: string
}

export interface HubRoute {
  /** The most this route reads; default MAX_BODY_BYTES. */
  cap?: number
  handle: (body: unknown, context: HubContext) => HubAnswer | Promise<HubAnswer>
}

export interface HubServerDeps {
  dataDir: string
  version: string
  /** Shown to devices: the hub's Tailscale machine name. */
  hubName: string
  hubPrivateKey: string
  hubPublicKey: string
  auth: AuthDeps
  /** Every route a device may call, by exact path; all are POST. */
  routes: Readonly<Record<string, HubRoute>>
  /** Codes, ids and counts only; never a body. */
  log: (line: string) => void
  /** A device paired: for the Activity page. */
  onPaired?: (deviceId: string) => void
  /** Tests only: loopback senders stand in for the tailnet. */
  allowLoopback?: boolean
}

export interface HubListen {
  hostname: string
  port: number
  /** Tests only: lets the listener bind loopback, where a test process stands in for the tailnet. */
  allowLoopback?: boolean
}

const PAIR_PATH = '/central/pair'
const PAIR_START_PATH = '/central/pair/start'

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra } })
}

function declaredLength(request: Request): number {
  const length = Number(request.headers.get('content-length') ?? '0')
  return Number.isFinite(length) ? length : 0
}

async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
  if (declaredLength(request) > limit) return null
  if (request.body === null) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function parseJson(bytes: Uint8Array): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { ok: false }
  }
}

const ID = /^[A-Za-z0-9_-]{1,64}$/
const NONCE = /^[A-Za-z0-9_-]{16,64}$/
/** Base64 of the 44-byte Ed25519 SPKI DER. */
const PUBLIC_KEY = /^[A-Za-z0-9+/]{59}=$/
const PROOF = /^[A-Za-z0-9+/=]{1,128}$/
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/

interface PairBody {
  deviceId: string
  deviceName: string
  devicePublicKey: string
  nonce: string
  proof: string
  version: string
}

function parsePair(value: unknown): PairBody | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const body = value as Record<string, unknown>
  const { deviceId, deviceName, devicePublicKey, nonce, proof, version } = body
  if (typeof deviceId !== 'string' || !ID.test(deviceId)) return null
  if (typeof deviceName !== 'string' || !NAME.test(deviceName)) return null
  if (typeof devicePublicKey !== 'string' || !PUBLIC_KEY.test(devicePublicKey)) return null
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return null
  if (typeof proof !== 'string' || !PROOF.test(proof)) return null
  if (typeof version !== 'string' || version.length > 64) return null
  return { deviceId, deviceName, devicePublicKey, nonce, proof, version }
}

const PAIR_REFUSALS = {
  'no-invite': { status: 410, error: 'no invite is open on the hub; run kinfold central invite there' },
  expired: { status: 410, error: 'the invite expired; run kinfold central invite on the hub for a new code' },
  'wrong-code': { status: 403, error: 'wrong code' },
  void: { status: 403, error: 'too many wrong codes; the invite is void. Run kinfold central invite on the hub again' },
} as const

/**
 * Pairing: the requesting node must belong to the hub's own Tailscale user,
 * checked first so nobody else can use up an invite's tries. Then the proof
 * must have been made with the open invite's code.
 */
async function pairRoute(request: Request, address: string, deps: HubServerDeps): Promise<Response> {
  const bytes = await readCapped(request, MAX_BODY_BYTES)
  if (bytes === null) return json(413, { error: 'body too large' })
  const parsed = parseJson(bytes)
  const body = parsed.ok ? parsePair(parsed.value) : null
  if (body === null) return json(400, { error: 'body must be a pairing request' })
  const node = await sameNode(deps.auth, address, null)
  if (node === null) {
    deps.log('central pair refused reason=identity')
    return json(403, { error: 'this node is not owned by the hub\'s Tailscale user' })
  }
  // After the identity check, so only the hub owner's nodes learn the hub's version.
  if (versionGap(body.version, deps.version) !== null) return json(409, { error: 'version', hubVersion: deps.version })
  // Pairing over a paired id would take that device's key and its projects; the device makes a new id each time it joins.
  if (findDevice(deps.dataDir, body.deviceId) !== null) return json(409, { error: 'that device id is already paired; try joining again' })
  const fields = { deviceId: body.deviceId, devicePublicKey: body.devicePublicKey, nonce: body.nonce }
  let key: Buffer | null = null
  const redeemed = redeemInvite(deps.dataDir, deps.auth.now(), (verifier) => {
    const candidate = proofKey(verifier)
    const ok = verifyDeviceProof(candidate, fields, body.proof)
    if (ok) key = candidate
    return ok
  })
  if (!redeemed.ok || key === null) {
    const refusal = PAIR_REFUSALS[redeemed.ok ? 'wrong-code' : redeemed.reason]
    deps.log(`central pair refused reason=${redeemed.ok ? 'wrong-code' : redeemed.reason}`)
    return json(refusal.status, { error: refusal.error })
  }
  addDevice(deps.dataDir, { id: body.deviceId, name: body.deviceName, publicKey: body.devicePublicKey, nodeId: node.nodeId, userId: node.userId, pairedAt: deps.auth.now() })
  deps.log(`central paired device=${body.deviceId}`)
  deps.onPaired?.(body.deviceId)
  const proof = hubProof(key, { hubPublicKey: deps.hubPublicKey, devicePublicKey: body.devicePublicKey, nonce: body.nonce })
  return json(200, { hubPublicKey: deps.hubPublicKey, hubName: deps.hubName, hubProof: proof, version: deps.version })
}

/** The first pairing step: the open invite's salt, for a node of the hub's own user only. */
async function pairStartRoute(address: string, deps: HubServerDeps): Promise<Response> {
  if ((await sameNode(deps.auth, address, null)) === null) return json(403, { error: 'this node is not owned by the hub\'s Tailscale user' })
  const invite = pendingInvite(deps.dataDir, deps.auth.now())
  if (invite === null) return json(PAIR_REFUSALS['no-invite'].status, { error: PAIR_REFUSALS['no-invite'].error })
  return json(200, { salt: invite.salt, hubName: deps.hubName, version: deps.version })
}

function signedAnswer(deps: HubServerDeps, requestSignature: string, answer: HubAnswer): Response {
  const text = JSON.stringify(answer.body)
  const signature = signReply(deps.hubPrivateKey, { requestSignature, status: answer.status, bodySha256: bodyHash(text) })
  return new Response(text, {
    status: answer.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', [HEADER.reply]: signature, [HEADER.version]: deps.version },
  })
}

export async function handleHubRequest(request: Request, address: string, deps: HubServerDeps): Promise<Response> {
  // The listener binds a Tailscale address, but a host on the LAN may still route to it; nothing it sends is looked at.
  if (!isTailscaleAddress(address) && !(deps.allowLoopback === true && isLoopbackAddress(address))) return json(403, { error: 'not a Tailscale address' })
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const url = new URL(request.url)
  if (url.pathname === PAIR_PATH) return pairRoute(request, address, deps)
  if (url.pathname === PAIR_START_PATH) return pairStartRoute(address, deps)
  // Nothing is read from a sender that is not a paired device.
  const deviceId = request.headers.get(HEADER.device) ?? ''
  const device = ID.test(deviceId) ? findDevice(deps.dataDir, deviceId) : null
  if (device === null) return json(401, { error: 'unpaired' })
  const route = Object.hasOwn(deps.routes, url.pathname) ? deps.routes[url.pathname] : undefined
  const bytes = await readCapped(request, route?.cap ?? MAX_BODY_BYTES)
  if (bytes === null) return json(413, { error: 'body too large' })
  const checked = await verifyCentralRequest({ method: request.method, path: `${url.pathname}${url.search}`, headers: request.headers, body: bytes, address }, deps.auth)
  if (!checked.ok) {
    deps.log(`central request refused status=${checked.status} reason=${checked.reason}`)
    return json(checked.status, { error: checked.reason })
  }
  const requestSignature = request.headers.get(HEADER.signature) ?? ''
  const answer = (value: HubAnswer): Response => signedAnswer(deps, requestSignature, value)
  if (route === undefined) return answer({ status: 404, body: { error: 'not found' } })
  if (versionGap(checked.version, deps.version) !== null) return answer({ status: 409, body: { error: 'version', hubVersion: deps.version } })
  const parsed = parseJson(bytes)
  if (!parsed.ok) return answer({ status: 400, body: { error: 'body is not JSON' } })
  const startedAt = performance.now()
  const result = await route.handle(parsed.value, { deviceId: checked.deviceId, deviceName: device.name, version: checked.version })
  deps.log(`central ${url.pathname} device=${checked.deviceId} status=${result.status} ms=${Math.round(performance.now() - startedAt)}`)
  return answer(result)
}

/** The address to bind: the first Tailscale address, or loopback when a test allows it. Throws when there is none. */
export function bindAddress(candidates: readonly string[], allowLoopback: boolean): string {
  const chosen = candidates.find(isTailscaleAddress) ?? (allowLoopback ? candidates.find(isLoopbackAddress) : undefined)
  if (chosen === undefined) throw new Error('no Tailscale address to listen on; is Tailscale running on this machine?')
  return chosen
}

export interface RunningHub {
  hostname: string
  port: number
  stop: () => Promise<void>
}

export function startHubServer(deps: HubServerDeps & HubListen): RunningHub {
  const hostname = bindAddress([deps.hostname], deps.allowLoopback === true)
  const server = Bun.serve({
    hostname,
    port: deps.port,
    maxRequestBodySize: MAX_BATCH_BYTES,
    fetch: (request, self) => handleHubRequest(request, self.requestIP(request)?.address ?? '', deps),
    error: (error) => {
      deps.log(`central request failed: ${error.name}`)
      return json(500, { error: 'internal error' })
    },
  })
  const port = server.port
  if (port === undefined) throw new Error('hub listener did not bind a port')
  return { hostname, port, stop: () => server.stop(true) }
}
