// The /dashboard routes: the login exchange and the static pages. server.ts
// has already run the Host check and checkAccess (access.ts), so a request
// that reaches a cookie route here holds a live session. Pages and assets are
// read from src/dashboard/public by an allowlist of plain file names, so no
// path in a URL can walk out of that folder. Logs carry the step and its
// outcome only, never a code, a cookie or a body.

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Parsed } from '../context/types'
import { isRecord } from '../contract/event'
import { isOwnPageRequest } from './access'
import { type DashboardAuth, clearedSessionCookie, sessionCookie, sessionFromCookie } from './auth'

export const PUBLIC_DIR = join(import.meta.dir, 'public')
const ASSET_PREFIX = '/dashboard/assets/'
const ASSET_NAME = /^[a-z0-9-]+\.(js|css)$/
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
}

export interface DashboardDeps {
  port: number
  auth: DashboardAuth
  readBody: () => Promise<Parsed<unknown>>
  log: (line: string) => void
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Every servable asset, read once at start; a file added later needs a restart. */
export function listAssets(dir: string = PUBLIC_DIR): ReadonlySet<string> {
  return new Set(readdirSync(dir).filter((name) => ASSET_NAME.test(name)))
}

const ASSETS = listAssets()

function file(name: string): Response {
  const type = CONTENT_TYPES[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream'
  return new Response(Bun.file(join(PUBLIC_DIR, name)), { status: 200, headers: { 'content-type': type } })
}

function onlyGet(request: Request, answer: () => Response): Response {
  return request.method === 'GET' ? answer() : json(405, { error: 'method not allowed' })
}

export function parseCodeBody(body: unknown): Parsed<string> {
  if (!isRecord(body) || typeof body.code !== 'string' || Object.keys(body).length !== 1) return { ok: false, error: 'body must be {"code": "<login code>"}' }
  return { ok: true, value: body.code }
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
  return new Response(null, { status: 204, headers: { 'set-cookie': sessionCookie(secret) } })
}

function logout(request: Request, deps: DashboardDeps): Response {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  deps.auth.endSession(sessionFromCookie(request.headers.get('cookie')))
  deps.log('dashboard session ended')
  return new Response(null, { status: 204, headers: { 'set-cookie': clearedSessionCookie() } })
}

function issueCode(request: Request, deps: DashboardDeps): Response {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const issued = deps.auth.issueCode()
  deps.log('dashboard login code issued')
  return json(200, issued)
}

/** Null when the path is not a /dashboard route, so the caller answers 404. */
export async function dashboardRoute(request: Request, path: string, deps: DashboardDeps): Promise<Response | null> {
  if (path === '/dashboard/login-code') return issueCode(request, deps)
  if (path === '/dashboard/session') return createSession(request, deps)
  if (path === '/dashboard/logout') return logout(request, deps)
  if (path === '/dashboard/login') return onlyGet(request, () => file('login.html'))
  if (path === '/dashboard') return onlyGet(request, () => new Response(null, { status: 308, headers: { location: '/dashboard/' } }))
  if (path === '/dashboard/') return onlyGet(request, () => file('index.html'))
  if (!path.startsWith(ASSET_PREFIX)) return null
  const name = path.slice(ASSET_PREFIX.length)
  return ASSETS.has(name) ? onlyGet(request, () => file(name)) : null
}
