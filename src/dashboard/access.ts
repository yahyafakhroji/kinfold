// Which credential each route accepts, and the extra checks a cookie request
// must pass. Existing API routes keep the Bearer token and never start taking
// the cookie; only the routes the dashboard calls take either. A browser
// sends the cookie on its own, so a state-changing cookie request must also
// prove it came from our page: an exact Origin and a custom header that a
// cross-site form or a simple fetch cannot add without a CORS preflight,
// which this server never answers. A few GETs change something too (a backup
// download records a backup, the update view uses up its banner, the central
// check calls the hub), and the cookie's SameSite rule ignores the port, so a
// page on another 127.0.0.1 port could send them with the cookie. Those GETs
// must come from our own origin as the browser itself reports it.

import { type DashboardAuth, sessionFromCookie } from './auth'

export type Access = 'public' | 'token' | 'either' | 'cookie'

export type Credential = 'token' | 'cookie' | 'none'

export type AccessResult = { ok: true; via: Credential } | { ok: false; status: 401 | 403; error: string }

export const REQUEST_HEADER = 'x-sam-request'
const SAFE_METHODS = new Set(['GET', 'HEAD'])
const EITHER_EXACT = new Set(['/central/status', '/observer/settings', '/embedding/settings', '/observer/test', '/observer/recheck', '/observer/models', '/observer/claude-token', '/metrics/summary', '/update', '/update/auto', '/update/settings', '/update/install', '/backup', '/restore', '/restore/upload', '/restore/undo', '/restore/status'])
const EITHER_PREFIXES = ['/data/', '/memory/']
// The claim is public like the session exchange: each carries its own single-use secret in the body, and the own-page check keeps other web pages out.
const PUBLIC_DASHBOARD = new Set(['/dashboard/login', '/dashboard/session', '/dashboard/claim'])

export function accessFor(path: string): Access {
  // `kinfold dashboard` holds its lease and asks for codes with the token; a browser never can.
  if (path === '/dashboard/login-code' || path === '/dashboard/offer' || path === '/dashboard/close' || path.startsWith('/dashboard/lease/')) return 'token'
  if (PUBLIC_DASHBOARD.has(path) || path.startsWith('/dashboard/assets/')) return 'public'
  if (path === '/dashboard' || path.startsWith('/dashboard/')) return 'cookie'
  if (EITHER_EXACT.has(path) || EITHER_PREFIXES.some((prefix) => path.startsWith(prefix))) return 'either'
  return 'token'
}

export function dashboardOrigin(port: number): string {
  return `http://127.0.0.1:${port}`
}

/** Origin, custom header; the Host check already ran before this. */
export function isOwnPageRequest(request: Request, port: number): boolean {
  return request.headers.get('origin') === dashboardOrigin(port) && request.headers.get(REQUEST_HEADER) === '1'
}

export function isStateChanging(method: string): boolean {
  return !SAFE_METHODS.has(method)
}

/** GETs with a side effect: /backup snapshots the store and records a backup, /update shows its banner once, /central/status?check=1 calls the hub. */
const SIDE_EFFECT_READS = new Set(['/backup', '/update', '/central/status'])

/**
 * Whether a GET came from our own page. Sec-Fetch-Site is set by the browser
 * and a page cannot change it; a page on another port of 127.0.0.1 reads
 * `same-site`, never `same-origin`. A browser too old to send it must show
 * our page's header and Origin, or a Referer on our origin (the Download
 * link is a plain navigation, which carries neither of the first two).
 */
export function isOwnPageRead(request: Request, port: number): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'
  if (isOwnPageRequest(request, port)) return true
  return request.headers.get('referer')?.startsWith(`${dashboardOrigin(port)}/`) === true
}

export interface AccessDeps {
  port: number
  hasToken: (header: string | null) => boolean
  auth: DashboardAuth
}

/**
 * An Authorization header decides on its own: a wrong token is 401 even with
 * a good cookie. Without one, a cookie counts only where the route takes it.
 */
export function checkAccess(request: Request, access: Access, deps: AccessDeps): AccessResult {
  if (access === 'public') return { ok: true, via: 'none' }
  const authorization = request.headers.get('authorization')
  if (authorization !== null) {
    if (access === 'cookie' || !deps.hasToken(authorization)) return { ok: false, status: 401, error: 'unauthorized' }
    return { ok: true, via: 'token' }
  }
  if (access === 'token' || !deps.auth.hasSession(sessionFromCookie(request.headers.get('cookie')))) {
    return { ok: false, status: 401, error: 'unauthorized' }
  }
  if (isStateChanging(request.method) && !isOwnPageRequest(request, deps.port)) return { ok: false, status: 403, error: 'forbidden origin' }
  if (!isStateChanging(request.method) && SIDE_EFFECT_READS.has(new URL(request.url).pathname) && !isOwnPageRead(request, deps.port)) return { ok: false, status: 403, error: 'forbidden origin' }
  return { ok: true, via: 'cookie' }
}
