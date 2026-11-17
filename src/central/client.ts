// A device's side of the conversation with its hub: pairing, then signed
// calls. Every answer to a signed call must carry the hub's signature over
// this request, its status and its body, made with the key learned at
// pairing; an answer that does not is treated as if the hub were not there.
// Pairing trusts the hub key only when the hub proves it knows the code.
// Calls never follow redirects and always run under a deadline, so a slow or
// missing hub costs a bounded wait, never a hung agent.

import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isIP } from 'node:net'
import { HEADER, signedHeaders } from './auth'
import { deviceProof, normalizeCode, proofKey, verifierFor, verifyHubProof } from './code'
import { bodyHash, newKeyPair, verifyReply } from './keys'
import { writeFileAtomic } from '../fs/atomic'
import { DATA_FILE_MODE } from '../store/data-dir'
import { centralDir, centralPath } from './paths'
import { type VersionGap, versionGap } from './version-rule'

export const DEFAULT_CALL_TIMEOUT_MS = 5_000
/** Far above any real answer: a dashboard view or an MCP read. */
export const MAX_ANSWER_BYTES = 16 * 1024 * 1024

export type HubFetch = (url: string, init: RequestInit) => Promise<Response>

export interface HubEndpoint {
  hub: string
  port: number
  hubPublicKey: string
  deviceId: string
  /** PEM, from <data>/central/device-key.pem. */
  privateKey: string
  /** This device's Kinfold version. */
  version: string
}

export type HubFailure = 'unreachable' | 'timeout' | 'bad-signature' | 'version' | 'unpaired' | 'refused' | 'bad-answer' | 'hub-error' | 'too-large'
export type HubCall = { ok: true; status: number; body: unknown } | { ok: false; reason: HubFailure; gap?: VersionGap }

export function hostPart(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host
}

const baseUrl = (host: string, port: number): string => `http://${hostPart(host)}:${port}`

/** The key in `file`, made and saved owner-only the first time. */
export function loadOrCreateKey(dataDir: string, file: string): string {
  const path = centralPath(dataDir, file)
  if (existsSync(path)) return readFileSync(path, 'utf8')
  const pair = newKeyPair()
  saveKey(dataDir, file, pair.privateKey)
  return pair.privateKey
}

export function saveKey(dataDir: string, file: string, privateKey: string): void {
  centralDir(dataDir)
  writeFileAtomic(centralPath(dataDir, file), privateKey, DATA_FILE_MODE)
}

export function readKey(dataDir: string, file: string): string | null {
  const path = centralPath(dataDir, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'Error'
}

const isTimeout = (error: unknown): boolean => ['TimeoutError', 'AbortError'].includes(errorName(error))

/** The body, read a chunk at a time and dropped the moment it passes the cap: a fake hub cannot make the device hold more. */
async function readText(response: Response): Promise<string | null> {
  const length = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > MAX_ANSWER_BYTES) return null
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_ANSWER_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export interface CallOptions {
  timeoutMs?: number
  fetch?: HubFetch
}

export async function callHub(endpoint: HubEndpoint, path: string, payload: unknown, options: CallOptions = {}): Promise<HubCall> {
  const body = JSON.stringify(payload)
  const headers = signedHeaders({ privateKey: endpoint.privateKey, deviceId: endpoint.deviceId, method: 'POST', path, body, version: endpoint.version })
  const fetchFn = options.fetch ?? ((url, init) => fetch(url, init))
  let response: Response
  let text: string | null
  try {
    response = await fetchFn(`${baseUrl(endpoint.hub, endpoint.port)}${path}`, {
      method: 'POST', body, redirect: 'error', headers: { ...headers, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
    })
    text = await readText(response)
  } catch (error: unknown) {
    return { ok: false, reason: isTimeout(error) ? 'timeout' : 'unreachable' }
  }
  if (text === null) return { ok: false, reason: 'bad-answer' }
  const replySignature = response.headers.get(HEADER.reply)
  if (replySignature === null) {
    // Refusals before the request is verified are not signed; they only ever lead to a status line.
    if (response.status === 401) return { ok: false, reason: (parse(text) as { error?: unknown } | undefined)?.error === 'unpaired' ? 'unpaired' : 'refused' }
    if (response.status === 403) return { ok: false, reason: 'refused' }
    // The hub signs every answer it reaches; a crash, or Bun refusing a body over its cap, comes back unsigned.
    if (response.status === 413) return { ok: false, reason: 'too-large' }
    if (response.status >= 500) return { ok: false, reason: 'hub-error' }
    return { ok: false, reason: 'bad-signature' }
  }
  const signed = { requestSignature: headers[HEADER.signature]!, status: response.status, bodySha256: bodyHash(text) }
  if (!verifyReply(endpoint.hubPublicKey, signed, replySignature)) return { ok: false, reason: 'bad-signature' }
  const value = parse(text)
  if (value === undefined) return { ok: false, reason: 'bad-answer' }
  if (response.status === 409 && typeof value === 'object' && value !== null && (value as { error?: unknown }).error === 'version') {
    const hubVersion = (value as { hubVersion?: unknown }).hubVersion
    return { ok: false, reason: 'version', gap: versionGap(endpoint.version, typeof hubVersion === 'string' ? hubVersion : '') ?? { older: 'device', hub: String(hubVersion), device: endpoint.version } }
  }
  return { ok: true, status: response.status, body: value }
}

export interface PairInput {
  dataDir: string
  hub: string
  port: number
  code: string
  deviceName?: string
  version: string
  fetch?: HubFetch
  timeoutMs?: number
}

export interface Paired {
  deviceId: string
  hubPublicKey: string
  hubName: string
  version: string
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const PUBLIC_KEY = /^[A-Za-z0-9+/]{59}=$/

async function postPlain(input: PairInput, path: string, body: unknown, timeoutError: string): Promise<Result<{ status: number; value: unknown }>> {
  const fetchFn = input.fetch ?? ((url, init) => fetch(url, init))
  const where = `${hostPart(input.hub)}:${input.port}`
  try {
    const response = await fetchFn(`${baseUrl(input.hub, input.port)}${path}`, {
      method: 'POST', body: JSON.stringify(body), redirect: 'error', headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS),
    })
    const text = await readText(response)
    const value = text === null ? undefined : parse(text)
    if (value === undefined) return { ok: false, error: `the hub at ${where} sent an answer Kinfold cannot read` }
    return { ok: true, value: { status: response.status, value } }
  } catch (error: unknown) {
    if (isTimeout(error)) return { ok: false, error: timeoutError }
    return { ok: false, error: `could not reach the hub at ${where} (${errorName(error)}); is it running kinfold central serve, and is Tailscale up on both machines?` }
  }
}

/**
 * Seen live: a Mac hub's firewall holds the first connection while it asks
 * whether to allow kinfold, so the device times out. A request that never
 * reached the hub spent none of the code's tries.
 */
export const PAIR_TIMEOUT = "the hub didn't answer in time; on a Mac hub, check for a firewall prompt to allow kinfold, then run the same command again (the code is still valid until it expires)"

/** The hub answered the first request, so the firewall let it through; it may have used the code up before the answer was lost. */
export const PAIR_LATE = 'the hub took the code but did not answer in time; run the same command again, and if the hub says the code is not valid, run kinfold central invite on the hub for a new one'


const errorOf = (value: unknown): string => (typeof value === 'object' && value !== null && typeof (value as { error?: unknown }).error === 'string' ? (value as { error: string }).error : 'refused')

/**
 * Pairs this device with the hub. A new key pair is made for each pairing and
 * saved only once the hub has proved it knows the code, so a failed attempt
 * leaves nothing behind.
 */
export async function pairWithHub(input: PairInput): Promise<Result<Paired>> {
  const code = normalizeCode(input.code)
  if (code === null) return { ok: false, error: 'that is not a Kinfold code; it looks like KF-XXXX-XXXX' }
  const start = await postPlain(input, '/central/pair/start', {}, PAIR_TIMEOUT)
  if (!start.ok) return start
  if (start.value.status === 409) return { ok: false, error: `the hub runs another Kinfold version; hub and devices need the same major.minor` }
  if (start.value.status !== 200) return { ok: false, error: `the hub refused: ${errorOf(start.value.value)}` }
  const salt = (start.value.value as { salt?: unknown }).salt
  if (typeof salt !== 'string' || salt.length > 64) return { ok: false, error: 'the hub sent an answer Kinfold cannot read' }

  const keys = newKeyPair()
  const deviceId = `dev-${randomBytes(9).toString('base64url')}`
  const nonce = randomBytes(18).toString('base64url')
  const key = proofKey(verifierFor(code, salt))
  const fields = { deviceId, devicePublicKey: keys.publicKey, nonce }
  const deviceName = (input.deviceName ?? hostname()).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'device'
  const pair = await postPlain(input, '/central/pair', { ...fields, deviceName, proof: deviceProof(key, fields), version: input.version }, PAIR_LATE)
  if (!pair.ok) return pair
  const answer = pair.value.value as Record<string, unknown>
  if (pair.value.status === 409) return { ok: false, error: `the hub runs Kinfold ${String(answer.hubVersion)} and this device ${input.version}; hub and devices need the same major.minor` }
  if (pair.value.status !== 200) return { ok: false, error: `the hub refused the code: ${errorOf(answer)}` }
  const { hubPublicKey, hubName, hubProof: proof, version } = answer
  if (typeof hubPublicKey !== 'string' || !PUBLIC_KEY.test(hubPublicKey) || typeof hubName !== 'string' || typeof proof !== 'string' || typeof version !== 'string') {
    return { ok: false, error: 'the hub sent an answer Kinfold cannot read' }
  }
  if (!verifyHubProof(key, { hubPublicKey, devicePublicKey: keys.publicKey, nonce }, proof)) return { ok: false, error: 'the hub could not prove it knows the code; nothing was saved' }
  saveKey(input.dataDir, 'device-key.pem', keys.privateKey)
  return { ok: true, value: { deviceId, hubPublicKey, hubName: hubName.slice(0, 64), version } }
}
