// The /dashboard routes: the leases `kinfold dashboard` holds while it runs,
// the login exchange and the static pages. server.ts
// has already run the Host check and checkAccess (access.ts), so a request
// that reaches a cookie route here holds a live session. A checkout serves
// the built app from src/dashboard/app/dist (src/dashboard/app-files.ts); a
// compiled program serves the files it carries (src/runtime/embedded.ts).
// Either way a name must be one plain file name the build wrote, so no path in
// a URL can walk out of that folder. Logs carry the step and its outcome only, never a code, a cookie or
// a body.

import { join } from 'node:path'
import type { Parsed } from '../context/types'
import { isRecord } from '../contract/event'
import { type EmbeddedAssets, embeddedAssets, safeDashboardName } from '../runtime/embedded'
import { isOwnPageRequest } from './access'
import { IMMUTABLE_ASSET_CACHE } from './headers'
import { APP_ASSETS, APP_DIST, ASSET_NAME, listAssets } from './app-files'
import { type DashboardAuth, type LeaseMode, clearedSessionCookie, sessionCookie, sessionFromCookie } from './auth'
import { type DashboardEvents, SIGNED_IN_NOTE } from './events'

export const CLOSED_MESSAGE = 'dashboard closed; run kinfold dashboard'
export const LEASE_PREFIX = '/dashboard/lease/'
const LEASE_ID = /^[A-Za-z0-9_-]{43}$/

const ASSET_PREFIX = '/dashboard/assets/'
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
}
const NOT_BUILT = 'the dashboard is not built in this checkout; run `bun run dashboard:build`'

export interface DashboardDeps {
  port: number
  auth: DashboardAuth
  readBody: () => Promise<Parsed<unknown>>
  events: DashboardEvents
  log: (line: string) => void
  /** A browser signed in, by a login link or by claiming the command's offer. */
  onSignIn?: () => void
  /** <data>/logs/daemon.log, which the Activity page offers as a download. */
  daemonLogPath?: string
  /** A central device's own events; its /memory/ reads come from the hub, so these are answered here. */
  deviceActivity?: () => unknown[]
  /** Test seam; a compiled program uses the assets it was built with. */
  assets?: EmbeddedAssets | null
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

// Read on the first request rather than at load: a checkout (and a test run) may build the app after
// this module loaded. A name that is not in the list makes it read again, so a build made after the
// daemon started is served too: Vite gives every build new hashed names, and a list read once would
// answer 404 for all of them until the daemon restarted.
let builtAssets: ReadonlySet<string> | null = null

/** Whether `name` is one of the app's built files. In a checkout the folder is listed again on a miss; a release holds its files in the program. */
function isAsset(name: string, assets: EmbeddedAssets | null, list: () => ReadonlySet<string> = listAssets): boolean {
  if (assets !== null) return ASSET_NAME.test(name) && assets.dashboardNames().includes(name)
  // Only a name shaped like a built file is worth a listing, so a scan of made-up paths reads no folder.
  if (!ASSET_NAME.test(name)) return false
  if (builtAssets === null || !builtAssets.has(name)) builtAssets = list()
  return builtAssets.has(name)
}

/** Test seams for the list of built files. */
export const assetListForTest = { isAsset, forget: (): void => void (builtAssets = null) }

function dashboardBlob(name: string, assets: EmbeddedAssets | null): Blob | null {
  if (!safeDashboardName(name)) return null
  if (assets !== null) return assets.dashboardFile(name)
  const blob = Bun.file(join(ASSET_NAME.test(name) ? APP_ASSETS : APP_DIST, name))
  return blob.size > 0 ? blob : null
}

function file(name: string, assets: EmbeddedAssets | null): Response {
  const blob = dashboardBlob(name, assets)
  if (blob === null) return json(404, { error: assets === null ? NOT_BUILT : 'not found' })
  const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
  // A built file's name carries the hash of its content, so a browser may keep it: a changed file has a new name.
  return new Response(blob, { status: 200, headers: { 'content-type': type, ...(ASSET_NAME.test(name) ? { 'cache-control': IMMUTABLE_ASSET_CACHE } : {}) } })
}

/** The log's newest part only: a daemon that ran for months writes far more than anyone reads. */
export const DAEMON_LOG_TAIL_BYTES = 2 * 1024 * 1024

/** The log holds counts, ids and timings, never prompts, memory or secrets, so the signed-in page may have it. */
async function daemonLog(path: string | undefined): Promise<Response> {
  const log = path === undefined ? null : Bun.file(path)
  if (log === null || !(await log.exists())) return json(404, { error: 'there is no daemon log yet; the service writes one once it runs Kinfold' })
  const start = Math.max(0, log.size - DAEMON_LOG_TAIL_BYTES)
  return new Response(log.slice(start), { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="kinfold-daemon.log"' } })
}

const METHOD_NOT_ALLOWED = (): Response => json(405, { error: 'method not allowed' })

function onlyGet(request: Request, answer: () => Response): Response {
  return request.method === 'GET' ? answer() : METHOD_NOT_ALLOWED()
}

function onlyPost(request: Request, answer: () => Response | Promise<Response>): Response | Promise<Response> {
  return request.method === 'POST' ? answer() : METHOD_NOT_ALLOWED()
}

/** A sign-in asked for by anything but this dashboard's own page is refused; `step` names the route in the log. */
function refusedOrigin(request: Request, deps: DashboardDeps, step: string): Response | null {
  if (isOwnPageRequest(request, deps.port)) return null
  deps.log(`dashboard ${step} refused reason=origin`)
  return json(403, { error: 'forbidden origin' })
}

/** The one end of both sign-in routes: the log line, the activity note, the hook and the session cookie. */
function signedIn(secret: string, deps: DashboardDeps): Response {
  deps.log('dashboard session created')
  deps.events.note(SIGNED_IN_NOTE)
  deps.onSignIn?.()
  return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(secret) } })
}

export function parseCodeBody(body: unknown): Parsed<string> {
  if (!isRecord(body) || typeof body.code !== 'string' || Object.keys(body).length !== 1) return { ok: false, error: 'body must be {"code": "<login code>"}' }
  return { ok: true, value: body.code }
}

export function parseLeaseBody(body: unknown): Parsed<LeaseMode> {
  if (!isRecord(body) || (body.mode !== 'live' && body.mode !== 'print') || Object.keys(body).length !== 1) return { ok: false, error: 'body must be {"mode": "live"} or {"mode": "print"}' }
  return { ok: true, value: body.mode }
}

function cursorOf(url: URL): number | null {
  const after = url.searchParams.get('after')
  return after !== null && /^\d{1,15}$/.test(after) ? Number(after) : null
}

const EPOCH = /^[A-Za-z0-9_-]{1,32}$/

function epochOf(url: URL): string | null {
  const epoch = url.searchParams.get('epoch')
  return epoch !== null && EPOCH.test(epoch) ? epoch : null
}

/**
 * PUT starts or renews a lease and answers the log since `?after=`; DELETE
 * ends it with its sessions. Token only (access.ts), so the id never reaches
 * a browser. Logs say what happened, never the id.
 */
async function lease(request: Request, id: string, deps: DashboardDeps): Promise<Response> {
  if (!LEASE_ID.test(id)) return json(400, { error: 'a lease id is 43 base64url characters' })
  if (request.method === 'DELETE') {
    const sessionsEnded = deps.auth.releaseLease(id)
    deps.log(`dashboard lease released sessions=${sessionsEnded}`)
    return json(200, { sessionsEnded })
  }
  if (request.method !== 'PUT') return json(405, { error: 'method not allowed' })
  const body = await deps.readBody()
  const mode = body.ok ? parseLeaseBody(body.value) : body
  if (!mode.ok) return json(400, { error: mode.error })
  const wasOpen = deps.auth.isOpen()
  const held = deps.auth.holdLease(id, mode.value)
  if (held === null) return json(409, { error: 'too many dashboards are open; `kinfold dashboard --close` ends the ones --print opened' })
  if (!wasOpen) deps.log(`dashboard opened mode=${mode.value}`)
  return json(200, { ttlMs: held.ttlMs, ...afterOf(new URL(request.url), deps.events) })
}

function afterOf(url: URL, events: DashboardEvents): ReturnType<DashboardEvents['after']> {
  return events.after(cursorOf(url), epochOf(url))
}

function closePrinted(request: Request, deps: DashboardDeps): Response {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const closed = deps.auth.closePrintLeases()
  deps.log(`dashboard print leases closed count=${closed}`)
  return json(200, { closed })
}

/** The code from the login link becomes a session cookie; a code works once, inside 60 s. */
async function createSession(request: Request, deps: DashboardDeps): Promise<Response> {
  const refused = refusedOrigin(request, deps, 'session')
  if (refused !== null) return refused
  const body = await deps.readBody()
  const code = body.ok ? parseCodeBody(body.value) : body
  if (!code.ok) return json(400, { error: code.error })
  const secret = deps.auth.redeemCode(code.value)
  if (secret === null) {
    deps.log('dashboard session refused reason=code')
    return json(401, { error: 'this login link is wrong, used or expired; run `kinfold dashboard` again' })
  }
  return signedIn(secret, deps)
}

function logout(request: Request, deps: DashboardDeps): Response {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  deps.auth.endSession(sessionFromCookie(request.headers.get('cookie')))
  deps.log('dashboard session ended')
  deps.events.note('signed out from a browser')
  return new Response(null, { status: 204, headers: { 'set-cookie': clearedSessionCookie() } })
}

export function parseCodeRequest(body: unknown): Parsed<string> {
  if (!isRecord(body) || typeof body.lease !== 'string' || Object.keys(body).length !== 1) return { ok: false, error: 'body must be {"lease": "<lease id>"}' }
  return { ok: true, value: body.lease }
}

const CLAIM_DIGEST = /^[0-9a-f]{64}$/
const CLAIM_SECRET = /^[A-Za-z0-9_-]{43}$/

/** The offer names the lease and the SHA-256 of the claim secret; the secret itself stays with the command and the page it opens. */
export function parseOfferRequest(body: unknown): Parsed<{ lease: string; claim: string }> {
  if (!isRecord(body) || typeof body.lease !== 'string' || typeof body.claim !== 'string' || !CLAIM_DIGEST.test(body.claim) || Object.keys(body).length !== 2) {
    return { ok: false, error: 'body must be {"lease": "<lease id>", "claim": "<sha-256 of the claim secret, hex>"}' }
  }
  return { ok: true, value: { lease: body.lease, claim: body.claim } }
}

export function parseClaimBody(body: unknown): Parsed<string> {
  if (!isRecord(body) || typeof body.claim !== 'string' || !CLAIM_SECRET.test(body.claim) || Object.keys(body).length !== 1) return { ok: false, error: 'body must be {"claim": "<claim secret>"}' }
  return { ok: true, value: body.claim }
}

/** The running command's offer of one sign-in, under its live lease, for the page it is about to open with the claim secret in its address fragment. */
async function offer(request: Request, deps: DashboardDeps): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const body = await deps.readBody()
  const parsed = body.ok ? parseOfferRequest(body.value) : body
  if (!parsed.ok) return json(400, { error: parsed.error })
  const offered = deps.auth.offerSignIn(parsed.value.lease, parsed.value.claim)
  if (offered === null) return json(409, { error: CLOSED_MESSAGE })
  deps.log('dashboard sign-in offered')
  return json(200, offered)
}

/**
 * The login page claims the offer the command made, with the claim secret the
 * command put in the page's address fragment. The Origin and header only stop
 * other web pages: any local program can send them, so the secret is what
 * ties the session to the browser the command opened. Each offer is claimed
 * once, so a second tab or a late claim gets nothing.
 */
async function claim(request: Request, deps: DashboardDeps): Promise<Response> {
  const refused = refusedOrigin(request, deps, 'claim')
  if (refused !== null) return refused
  const body = await deps.readBody()
  const claimSecret = body.ok ? parseClaimBody(body.value) : body
  const secret = claimSecret.ok ? deps.auth.claimSignIn(claimSecret.value) : null
  if (secret === null) {
    deps.log(`dashboard claim refused reason=${claimSecret.ok ? 'secret' : 'body'}`)
    return json(401, { error: 'this sign-in is wrong, used or expired; run `kinfold dashboard` in a terminal' })
  }
  return signedIn(secret, deps)
}

/** A code only under a live lease: without one the dashboard is closed. */
async function issueCode(request: Request, deps: DashboardDeps): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const body = await deps.readBody()
  const leaseId = body.ok ? parseCodeRequest(body.value) : body
  if (!leaseId.ok) return json(400, { error: leaseId.error })
  const issued = deps.auth.issueCode(leaseId.value)
  if (issued === null) return json(409, { error: CLOSED_MESSAGE })
  deps.log('dashboard login code issued')
  return json(200, issued)
}

/** Null when the path is not a /dashboard route, so the caller answers 404. */
export async function dashboardRoute(request: Request, path: string, deps: DashboardDeps): Promise<Response | null> {
  const assets = deps.assets === undefined ? embeddedAssets() : deps.assets
  if (path.startsWith(LEASE_PREFIX)) return lease(request, path.slice(LEASE_PREFIX.length), deps)
  if (path === '/dashboard/close') return closePrinted(request, deps)
  // The page asks this every few seconds; reaching here means its session and lease are live.
  if (path === '/dashboard/state') return onlyGet(request, () => new Response(null, { status: 204 }))
  if (path === '/dashboard/login-code') return issueCode(request, deps)
  if (path === '/dashboard/offer') return offer(request, deps)
  if (path === '/dashboard/claim') return onlyPost(request, () => claim(request, deps))
  if (path === '/dashboard/session') return onlyPost(request, () => createSession(request, deps))
  if (path === '/dashboard/logout') return logout(request, deps)
  if (path === '/dashboard/device-activity') return onlyGet(request, () => json(200, { rows: deps.deviceActivity?.() ?? [] }))
  if (path === '/dashboard/daemon-log') return request.method === 'GET' ? daemonLog(deps.daemonLogPath) : json(405, { error: 'method not allowed' })
  if (path === '/dashboard/login') return onlyGet(request, () => file('login.html', assets))
  if (path === '/dashboard') return onlyGet(request, () => new Response(null, { status: 308, headers: { location: '/dashboard/' } }))
  if (path === '/dashboard/') return onlyGet(request, () => file('index.html', assets))
  if (!path.startsWith(ASSET_PREFIX)) return null
  const name = path.slice(ASSET_PREFIX.length)
  return isAsset(name, assets) ? onlyGet(request, () => file(name, assets)) : null
}
