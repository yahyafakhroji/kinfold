// The /dashboard routes: the leases `kinfold dashboard` holds while it runs,
// the login exchange and the static pages. server.ts
// has already run the Host check and checkAccess (access.ts), so a request
// that reaches a cookie route here holds a live session. A checkout reads
// pages and assets from src/dashboard/public; a compiled program reads the
// files it carries (src/runtime/embedded.ts). Either way the name must be one
// plain file name from a fixed list, so no path in a URL can walk out of that
// folder. Logs carry the step and its outcome only, never a code, a cookie or
// a body.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Parsed } from '../context/types'
import { isRecord } from '../contract/event'
import { type EmbeddedAssets, embeddedAssets, safeDashboardName } from '../runtime/embedded'
import { isOwnPageRequest } from './access'
import { type DashboardAuth, type LeaseMode, clearedSessionCookie, sessionCookie, sessionFromCookie } from './auth'
import type { DashboardEvents } from './events'

export const CLOSED_MESSAGE = 'dashboard closed; run kinfold dashboard'
export const LEASE_PREFIX = '/dashboard/lease/'
const LEASE_ID = /^[A-Za-z0-9_-]{43}$/

export const PUBLIC_DIR = join(import.meta.dir, 'public')
const ASSET_PREFIX = '/dashboard/assets/'
const ASSET_NAME = /^[a-z0-9-]+\.(js|css)$/
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
}

/** The files a release build carries; its generated module serves them by name. */
export const EMBEDDED_ASSET_NAMES = [
  'api.js', 'app.css', 'app.js', 'central-mark.js', 'display-block.js', 'dom.js', 'embeddings-block.js', 'format.js', 'hash.js', 'login.js',
  'page-backup.js', 'page-data.js', 'page-memory.js', 'page-metrics.js', 'page-models.js', 'page-sessions.js', 'purge-flow.js', 'restore-flow.js', 'retention-flow.js', 'update-banner.js', 'update-install.js', 'updates-block.js',
] as const

export interface DashboardDeps {
  port: number
  auth: DashboardAuth
  readBody: () => Promise<Parsed<unknown>>
  events: DashboardEvents
  log: (line: string) => void
  /** Test seam; a compiled program uses the assets it was built with. */
  assets?: EmbeddedAssets | null
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Every servable asset, read once at start; a file added later needs a restart. */
export function listAssets(dir: string = PUBLIC_DIR): ReadonlySet<string> {
  try {
    return new Set(readdirSync(dir).filter((name) => ASSET_NAME.test(name)))
  } catch (error: unknown) {
    // A compiled program has no public folder on disk; its assets are embedded.
    // Any other failure would turn every asset into a silent 404, so it must not
    // read as an empty folder.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set()
    throw error
  }
}

const PUBLIC_ASSETS = listAssets()
const EMBEDDED_ASSETS: ReadonlySet<string> = new Set(EMBEDDED_ASSET_NAMES)

function assetNames(assets: EmbeddedAssets | null): ReadonlySet<string> {
  return assets === null ? PUBLIC_ASSETS : EMBEDDED_ASSETS
}

function dashboardBlob(name: string, assets: EmbeddedAssets | null): Blob | null {
  if (!safeDashboardName(name)) return null
  return assets === null ? Bun.file(join(PUBLIC_DIR, name)) : assets.dashboardFile(name)
}

function file(name: string, assets: EmbeddedAssets | null): Response {
  const blob = dashboardBlob(name, assets)
  if (blob === null) return json(404, { error: 'not found' })
  const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
  return new Response(blob, { status: 200, headers: { 'content-type': type } })
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
  if (path === '/dashboard/login') return onlyGet(request, () => file('login.html', assets))
  if (path === '/dashboard') return onlyGet(request, () => new Response(null, { status: 308, headers: { location: '/dashboard/' } }))
  if (path === '/dashboard/') return onlyGet(request, () => file('index.html', assets))
  if (!path.startsWith(ASSET_PREFIX)) return null
  const name = path.slice(ASSET_PREFIX.length)
  return assetNames(assets).has(name) ? onlyGet(request, () => file(name, assets)) : null
}
