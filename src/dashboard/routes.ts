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
import { APP_ASSETS, APP_DIST, ASSET_NAME, listAssets } from './app-files'
import { type DashboardAuth, type LeaseMode, clearedSessionCookie, sessionCookie, sessionFromCookie } from './auth'
import type { DashboardEvents } from './events'

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
// this module loaded. An empty list is read again, so a build made after the daemon started is served.
let builtAssets: ReadonlySet<string> | null = null

function assetNames(assets: EmbeddedAssets | null): ReadonlySet<string> {
  if (assets !== null) return new Set(assets.dashboardNames().filter((name) => ASSET_NAME.test(name)))
  if (builtAssets === null || builtAssets.size === 0) builtAssets = listAssets()
  return builtAssets
}

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
  return new Response(blob, { status: 200, headers: { 'content-type': type } })
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

function onlyGet(request: Request, answer: () => Response): Response {
  return request.method === 'GET' ? answer() : json(405, { error: 'method not allowed' })
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
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  if (!isOwnPageRequest(request, deps.port)) {
    deps.log('dashboard session refused reason=origin')
    return json(403, { error: 'forbidden origin' })
  }
  const body = await deps.readBody()
  const code = body.ok ? parseCodeBody(body.value) : body
  if (!code.ok) return json(400, { error: code.error })
  const secret = deps.auth.redeemCode(code.value)
  if (secret === null) {
    deps.log('dashboard session refused reason=code')
    return json(401, { error: 'this login link is wrong, used or expired; run `kinfold dashboard` again' })
  }
  deps.log('dashboard session created')
  deps.events.note('signed in from a browser')
  deps.onSignIn?.()
  return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(secret) } })
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

/** The running command's offer of one sign-in, under its live lease, for the page it is about to open at a plain address. */
async function offer(request: Request, deps: DashboardDeps): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const body = await deps.readBody()
  const leaseId = body.ok ? parseCodeRequest(body.value) : body
  if (!leaseId.ok) return json(400, { error: leaseId.error })
  const offered = deps.auth.offerSignIn(leaseId.value)
  if (offered === null) return json(409, { error: CLOSED_MESSAGE })
  deps.log('dashboard sign-in offered')
  return json(200, offered)
}

/**
 * The login page claims the offer the command made. Only a page served from
 * this daemon's own origin can send the Origin and header this needs, and
 * each offer is claimed once, so a second tab or a late claim gets nothing.
 */
function claim(request: Request, deps: DashboardDeps): Response {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  if (!isOwnPageRequest(request, deps.port)) {
    deps.log('dashboard claim refused reason=origin')
    return json(403, { error: 'forbidden origin' })
  }
  const secret = deps.auth.claimSignIn()
  if (secret === null) {
    deps.log('dashboard claim refused reason=none')
    return json(401, { error: 'no sign-in is waiting; run `kinfold dashboard` in a terminal' })
  }
  deps.log('dashboard session created')
  deps.events.note('signed in from a browser')
  deps.onSignIn?.()
  return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(secret) } })
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
  if (path === '/dashboard/claim') return claim(request, deps)
  if (path === '/dashboard/session') return createSession(request, deps)
  if (path === '/dashboard/logout') return logout(request, deps)
  if (path === '/dashboard/device-activity') return onlyGet(request, () => json(200, { rows: deps.deviceActivity?.() ?? [] }))
  if (path === '/dashboard/daemon-log') return request.method === 'GET' ? daemonLog(deps.daemonLogPath) : json(405, { error: 'method not allowed' })
  if (path === '/dashboard/login') return onlyGet(request, () => file('login.html', assets))
  if (path === '/dashboard') return onlyGet(request, () => new Response(null, { status: 308, headers: { location: '/dashboard/' } }))
  if (path === '/dashboard/') return onlyGet(request, () => file('index.html', assets))
  if (!path.startsWith(ASSET_PREFIX)) return null
  const name = path.slice(ASSET_PREFIX.length)
  return assetNames(assets).has(name) ? onlyGet(request, () => file(name, assets)) : null
}
