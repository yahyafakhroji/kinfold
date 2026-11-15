// The daemon's loopback HTTP surface. Any local web page can reach 127.0.0.1,
// so binding to loopback is not enough: every route but /health needs a
// credential, a Host check stops DNS rebinding, and no CORS headers means a
// browser never hands a page the response. The credential is the
// data-directory token, or for the routes the dashboard calls, its session
// cookie (src/dashboard/access.ts decides which route takes which). Every
// answer carries the dashboard's CSP and no-store headers.
//
// Bun's own body cap is server-wide, and the restore upload needs it high, so
// the 16 KB limit of every other route is kept here: a declared length past it
// is refused unread, and a body is read by counting, never whole. Both come
// after the Host and credential checks, so a request without credentials
// cannot make the daemon read anything.

import { timingSafeEqual } from 'node:crypto'
import { type ContextRequest, type ContextResult, type Parsed, parseContextRequest } from '../context/types'
import { type Access, type AccessResult, accessFor, checkAccess } from '../dashboard/access'
import type { DashboardAuth } from '../dashboard/auth'
import { withSecurityHeaders } from '../dashboard/headers'
import { dashboardRoute } from '../dashboard/routes'
import type { RetryTarget } from '../store/observer-reset'
import type { McpRead } from '../store/mcp-read-store'
import type { SessionSummary } from '../store/reads'
import type { BackupRoutes } from './backup-routes'
import { type DataHandlers, type RouteAnswer, dataRoute } from './data-routes'
import { parseMcpRead } from './mcp-read-route'
import { type ReadRouteDeps, readRoute } from './read-routes'
import type { HmacMode } from './hmac-rotation'
import { type MemoryHandlers, memoryRoute } from './memory-routes'
import type { ObserverModelsRoute } from './observer-models-route'
import type { ObserverTestRoute } from './observer-test'
import { type ObserverSettingsHandlers, parseRecheck, parseSettingsPut } from './settings-route'
import { type SemanticAnswer, type SemanticRequest, parseSemanticRequest } from '../vectors/search'
import type { Exclusive } from '../vectors/vector-worker'

export interface ServerDeps {
  /** 0 picks a free port. */
  port: number
  token: string
  version: string
  schemaVersion: number
  /** /health reports it so a service can tell its daemon from a process that reused a stale daemon.json pid. Default: this process's. */
  pid?: number
  /** The HMAC key mode, live: /health reports it so `kinfold install` knows the daemon reads the master. Never key bytes. */
  hmacMode?: () => HmacMode
  /** Whether sqlite-vec loaded; /health reports it so `kinfold status` can say why search is keyword-only. */
  vectorSearch?: 'on' | 'off'
  /** POST /search/semantic (token only): nearest observations to a query. Absent: answers unavailable. */
  semanticSearch?: (request: SemanticRequest) => Promise<SemanticAnswer>
  onNudge: () => void
  listSessions: (projectKey: string | null) => SessionSummary[]
  /** POST /context: the project's pack for this host, with its injection recorded. */
  context: (request: ContextRequest) => ContextResult | Promise<ContextResult>
  /** POST /observer/retry: failed events back to pending; returns how many. */
  retryFailed: (target: RetryTarget) => number
  /** GET and PUT /observer/settings: one row per host, written only here. */
  observerSettings: ObserverSettingsHandlers
  /** /data/size, /data/retention, /data/scan, /data/findings, /data/findings/:id/resolve, /data/purge. */
  data: DataHandlers
  /** Runs retention, purge and resolve clear of the vector worker's read snapshot; default at once. */
  exclusive?: Exclusive
  /** GET /memory/observations, /memory/observations/:id, /memory/facets (the dashboard's memory browser). */
  memory: MemoryHandlers
  /** GET /update: the banner the dashboard shows; absent or null means none. Reads only, never marks a notice shown. */
  updateBanner?: () => { version: string; message: string } | null
  /** GET /metrics/summary. */
  metrics: (window: string | null) => RouteAnswer
  /** POST /metrics/mcp-read: one MCP tool call reported by the read-only MCP server (token only). */
  mcpRead: (read: McpRead) => number
  /** POST /observer/test: one fixed prompt through the chosen runner. */
  observerTest: ObserverTestRoute
  /** GET /observer/models: the installed CLI's model names, cached for ten minutes. */
  observerModels: ObserverModelsRoute
  /** Login codes and session cookies for the dashboard; in memory only. */
  auth: DashboardAuth
  /** The /read/ routes (token only); absent, every /read/ path is 404. */
  reads?: ReadRouteDeps
  /** GET /backup, POST /restore/upload, POST /restore, GET /restore/status; absent, each is 404. */
  backup?: BackupRoutes
  /** Why the store cannot be reached right now (a restore is replacing it), or null. Routes that read or write it answer 503 meanwhile. */
  unavailable?: () => string | null
  /** Receives counts, ids and error messages only, never payloads. */
  log: (line: string) => void
}

export interface RunningServer {
  port: number
  stop: () => Promise<void>
}

export const LOOPBACK_HOST = '127.0.0.1'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

export function isAllowedHost(host: string | null, port: number): boolean {
  return host === `${LOOPBACK_HOST}:${port}` || host === `localhost:${port}`
}

export function hasToken(header: string | null, token: string): boolean {
  if (header === null) return false
  const given = Buffer.from(header)
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** Bodies are a few hundred bytes; anything far larger is not a client of ours. */
export const MAX_BODY_BYTES = 16_384
/** The most the restore upload may ever take, and so the server-wide cap; the route lowers it to what the disk can hold. */
export const MAX_UPLOAD_BYTES = 8 * 1024 ** 3
const UPLOAD_PATH = '/restore/upload'
const BACKUP_PATHS: ReadonlySet<string> = new Set(['/backup', '/restore', UPLOAD_PATH, '/restore/status'])

function declaredLength(request: Request): number {
  const length = Number(request.headers.get('content-length') ?? '0')
  return Number.isFinite(length) ? length : 0
}

/** The body, read a chunk at a time and dropped the moment it passes `limit` (null then): a sender cannot make the daemon hold more than the cap. */
async function readCapped(request: Request, limit: number): Promise<Uint8Array | null> {
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

async function readJson(request: Request): Promise<Parsed<unknown>> {
  // Counted in bytes before decoding: a body of multi-byte characters is several times its length in characters.
  const bytes = declaredLength(request) > MAX_BODY_BYTES ? null : await readCapped(request, MAX_BODY_BYTES)
  if (bytes === null) return { ok: false, error: 'body too large' }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { ok: false, error: 'body is not JSON' }
  }
}

export function parseRetryTarget(body: unknown): Parsed<RetryTarget> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' }
  if ('sessionId' in body && Number.isSafeInteger(body.sessionId) && (body.sessionId as number) > 0) {
    return { ok: true, value: { sessionId: body.sessionId as number } }
  }
  if ('all' in body && body.all === true) return { ok: true, value: { all: true } }
  return { ok: false, error: 'body must be {"sessionId": <id>} or {"all": true}' }
}

async function postJson<T>(request: Request, parse: (body: unknown) => Parsed<T>, answer: (value: T) => Response | Promise<Response>): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const body = await readJson(request)
  const parsed = body.ok ? parse(body.value) : body
  return parsed.ok ? answer(parsed.value) : json(400, { error: parsed.error })
}

async function observerSettingsRoute(request: Request, handlers: ObserverSettingsHandlers): Promise<Response> {
  if (request.method === 'GET') return json(200, handlers.list())
  if (request.method !== 'PUT') return json(405, { error: 'method not allowed' })
  const body = await readJson(request)
  const parsed = body.ok ? parseSettingsPut(body.value) : body
  return parsed.ok ? json(200, { saved: handlers.put(parsed.value) }) : json(400, { error: parsed.error })
}

/** Status, hit count and timings in the log; the query never. */
async function semanticRoute(request: Request, deps: ServerDeps): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
  const body = await readJson(request)
  const parsed = body.ok ? parseSemanticRequest(body.value) : body
  if (!parsed.ok) return json(400, { error: parsed.error })
  const search = deps.semanticSearch
  // The MCP client aborts at its deadline; a read still queued then is skipped rather than scanned for no one.
  const answer: SemanticAnswer = search === undefined
    ? { status: 'unavailable', reason: 'semantic search is not configured in this daemon' }
    : await search({ ...parsed.value, giveUpMs: parsed.value.deadlineMs })
  const detail = answer.status === 'ok' ? ` hits=${answer.hits.length} embed_ms=${answer.embedMs} search_ms=${answer.searchMs} cached=${answer.cached}` : ''
  deps.log(`semantic search status=${answer.status}${detail}`)
  return json(200, answer)
}

async function route(request: Request, url: URL, deps: ServerDeps): Promise<Response> {
  if (url.pathname === '/observer/settings') return observerSettingsRoute(request, deps.observerSettings)
  if (url.pathname === '/observer/recheck') {
    return postJson(request, parseRecheck, (provider) => json(200, { ok: true, cleared: deps.observerSettings.recheck(provider) }))
  }
  if (url.pathname === '/search/semantic') return semanticRoute(request, deps)
  if (url.pathname === '/context') return postJson(request, parseContextRequest, async (value) => json(200, await deps.context(value)))
  if (url.pathname === '/metrics/mcp-read') return postJson(request, parseMcpRead, (value) => json(201, { id: deps.mcpRead(value) }))
  if (url.pathname === '/observer/retry') {
    return postJson(request, parseRetryTarget, (value) => json(200, { reset: deps.retryFailed(value) }))
  }
  if (url.pathname === '/spool/nudge') {
    if (request.method !== 'POST') return json(405, { error: 'method not allowed' })
    deps.onNudge()
    return json(202, { accepted: true })
  }
  if (url.pathname === '/sessions') {
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' })
    const sessions = deps.listSessions(url.searchParams.get('project'))
    return json(200, { sessions })
  }
  const answer = await panelRoute(request, url, deps)
  return answer === null ? json(404, { error: 'not found' }) : json(answer.status, answer.body)
}

/** The routes the dashboard reads and writes besides /observer/settings: data control, memory, metrics, model test. */
async function panelRoute(request: Request, url: URL, deps: ServerDeps): Promise<RouteAnswer | null> {
  const path = url.pathname
  if (path.startsWith('/data/')) return dataRoute(request.method, url, () => readJson(request), deps.data, deps.exclusive)
  if (path.startsWith('/memory/')) return memoryRoute(request.method, url, deps.memory)
  if (path === '/observer/models') return deps.observerModels(request.method, url)
  if (path === '/observer/test') return deps.observerTest(request.method, () => readJson(request))
  if (path === '/update') return request.method === 'GET' ? { status: 200, body: { notice: deps.updateBanner?.() ?? null } } : { status: 405, body: { error: 'method not allowed' } }
  if (path === '/metrics/summary') return request.method === 'GET' ? deps.metrics(url.searchParams.get('window')) : { status: 405, body: { error: 'method not allowed' } }
  if (path.startsWith('/read/') && deps.reads !== undefined) return readRoute(request.method, path, () => readJson(request), deps.reads, deps.log)
  return null
}

/** Backup and restore: the one place a body may be larger than 16 KB, and the routes that still answer while the store is being replaced. */
async function backupRoute(request: Request, path: string, deps: ServerDeps): Promise<Response> {
  const routes = deps.backup
  if (routes === undefined) return json(404, { error: 'not found' })
  const wrongMethod = json(405, { error: 'method not allowed' })
  if (path === '/backup') return request.method === 'GET' ? routes.download() : wrongMethod
  const answered = (answer: RouteAnswer): Response => json(answer.status, answer.body)
  if (path === '/restore/status') return request.method === 'GET' ? answered(routes.status()) : wrongMethod
  if (request.method !== 'POST') return wrongMethod
  return answered(path === UPLOAD_PATH ? await routes.upload(request) : await routes.start(() => readJson(request)))
}

async function storeRoute(request: Request, url: URL, deps: ServerDeps): Promise<Response> {
  const down = deps.unavailable?.() ?? null
  return down === null ? route(request, url, deps) : json(503, { error: down })
}

const DASHBOARD_PAGES = new Set(['/dashboard', '/dashboard/'])

/** A signed-out browser opening the app page goes to the login page, which explains `kinfold dashboard`. */
function refused(request: Request, path: string, access: Access, result: Extract<AccessResult, { ok: false }>, deps: ServerDeps): Response {
  if (access === 'cookie' && result.status === 401 && request.method === 'GET' && DASHBOARD_PAGES.has(path)) {
    return new Response(null, { status: 303, headers: { location: '/dashboard/login' } })
  }
  if (result.status === 403) deps.log(`request refused status=403 reason=origin method=${request.method}`)
  return json(result.status, { error: result.error })
}

/**
 * The dashboard lives on one origin, http://127.0.0.1:<port>: its session
 * cookie is scoped there and the Origin check names it. A browser that opened
 * localhost:<port> is sent to the same path on 127.0.0.1 before any other
 * step, so localhost never serves a page, issues a cookie or redeems a code.
 * The login code rides in the fragment, which the browser keeps across the
 * redirect. Every other host name still gets the strict 403 above.
 */
export function localhostRedirect(host: string | null, url: URL, port: number): Response | null {
  if (host !== `localhost:${port}`) return null
  if (url.pathname !== '/dashboard' && !url.pathname.startsWith('/dashboard/')) return null
  return new Response(null, { status: 303, headers: { location: `http://${LOOPBACK_HOST}:${port}${url.pathname}${url.search}` } })
}

async function answer(request: Request, port: number, deps: ServerDeps): Promise<Response> {
  if (!isAllowedHost(request.headers.get('host'), port)) return json(403, { error: 'forbidden host' })
  const url = new URL(request.url)
  const redirect = localhostRedirect(request.headers.get('host'), url, port)
  if (redirect !== null) return redirect
  if (url.pathname === '/health' && request.method === 'GET') {
    const hmac = deps.hmacMode !== undefined ? { hmacMode: deps.hmacMode() } : {}
    const vectors = deps.vectorSearch !== undefined ? { vectorSearch: deps.vectorSearch } : {}
    return json(200, { ok: true, version: deps.version, schemaVersion: deps.schemaVersion, pid: deps.pid ?? process.pid, ...hmac, ...vectors })
  }
  const access = accessFor(url.pathname)
  const checked = checkAccess(request, access, { port, hasToken: (header) => hasToken(header, deps.token), auth: deps.auth })
  if (!checked.ok) return refused(request, url.pathname, access, checked, deps)
  // Every route but the upload keeps the 16 KB limit Bun's cap used to give it, body-reading or not.
  if (url.pathname !== UPLOAD_PATH && declaredLength(request) > MAX_BODY_BYTES) return json(413, { error: 'body too large' })
  const startedAt = performance.now()
  const dashboard = url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')
    ? await dashboardRoute(request, url.pathname, { port, auth: deps.auth, readBody: () => readJson(request), log: deps.log })
    : undefined
  const other = (): Promise<Response> => (BACKUP_PATHS.has(url.pathname) ? backupRoute(request, url.pathname, deps) : storeRoute(request, url, deps))
  const response = dashboard === undefined ? await other() : (dashboard ?? json(404, { error: 'not found' }))
  // Route, status and time only: no query string, body or cookie.
  if (checked.via === 'cookie') deps.log(`dashboard ${request.method} ${url.pathname} status=${response.status} ms=${Math.round(performance.now() - startedAt)}`)
  return response
}

export async function handleRequest(request: Request, port: number, deps: ServerDeps): Promise<Response> {
  return withSecurityHeaders(await answer(request, port, deps))
}

export function startServer(deps: ServerDeps): RunningServer {
  const server = Bun.serve({
    hostname: LOOPBACK_HOST,
    port: deps.port,
    // Server-wide, so it is the upload's ceiling; every other route is held to MAX_BODY_BYTES in answer() and readJson.
    maxRequestBodySize: MAX_UPLOAD_BYTES,
    fetch: (request, self) => handleRequest(request, self.port ?? deps.port, deps),
    error: (error) => {
      // The name only: a SQLite message can echo query fragments, and prompt terms are query fragments.
      deps.log(`request failed: ${error.name}`)
      return json(500, { error: 'internal error' })
    },
  })
  const port = server.port
  if (port === undefined) throw new Error('server did not bind a port')
  return { port, stop: () => server.stop(true) }
}
