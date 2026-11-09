// Which credential each route accepts, and the extra checks a cookie request
// must pass. Existing API routes keep the Bearer token and never start taking
// the cookie; only the routes the dashboard calls take either. A browser
// sends the cookie on its own, so a state-changing cookie request must also
// prove it came from our page: an exact Origin and a custom header that a
// cross-site form or a simple fetch cannot add without a CORS preflight,
// which this server never answers.

import { type DashboardAuth, sessionFromCookie } from './auth'

export type Access = 'public' | 'token' | 'either' | 'cookie'

export type Credential = 'token' | 'cookie' | 'none'

export type AccessResult = { ok: true; via: Credential } | { ok: false; status: 401 | 403; error: string }

export const REQUEST_HEADER = 'x-sam-request'
const SAFE_METHODS = new Set(['GET', 'HEAD'])
const EITHER_EXACT = new Set(['/observer/settings', '/observer/test', '/observer/recheck', '/observer/models', '/metrics/summary', '/update'])
const EITHER_PREFIXES = ['/data/', '/memory/']
const PUBLIC_DASHBOARD = new Set(['/dashboard/login', '/dashboard/session'])

export function accessFor(path: string): Access {
  if (path === '/dashboard/login-code') return 'token'
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
  return { ok: true, via: 'cookie' }
}
