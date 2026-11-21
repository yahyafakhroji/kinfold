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
import { type Access, type AccessResult, type Credential, accessFor, checkAccess } from '../dashboard/access'
import { type DashboardAuth, sessionFromCookie } from '../dashboard/auth'
import { type DashboardEvents, createDashboardEvents } from '../dashboard/events'
import { withSecurityHeaders } from '../dashboard/headers'
import { CLOSED_MESSAGE, LEASE_PREFIX, dashboardRoute } from '../dashboard/routes'
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
import type { EmbeddingRoute } from './embedding-route'
import { type ObserverSettingsHandlers, parseRecheck, parseSettingsPut, parseTokenPut } from './settings-route'
import { type SemanticAnswer, type SemanticRequest, parseSemanticRequest } from '../vectors/search'
import type { Exclusive } from '../vectors/vector-worker'
import type { AutoUpdateView } from '../update/auto'
import type { InstallRun } from '../update/install-run'
import { parseVersion } from '../update/version-order'
import { type UpdateLevel, isUpdateLevel } from '../install/setup/record'
import { type DeviceRouting, deviceRoute } from '../central/device-routes'

export interface ServerDeps {
  /** 0 picks a free port. */
  port: number
  /** Times each request's synchronous part under `route <path>` for the stall watch; default runs it as is. */
  step?: <T>(label: string, fn: () => T) => T
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
  /** GET /update, GET /update/quiet and GET or PUT /update/auto; absent means no banner and no switch. */
  update?: UpdateHandlers
  /**
   * Called for every request that passed its access check, except /health,
   * the update questions and the CLI's settings read: an agent, an MCP client or the dashboard is at work,
   * and an update must not restart the daemon under it.
   */
  onActivity?: () => void
  /** GET /metrics/summary. */
  metrics: (window: string | null) => Promise<RouteAnswer>
  /** GET /projects, POST /projects/merge and /projects/split (`kinfold project`); null for any other path. Absent: 404. */
  projects?: (method: string, url: URL, readBody: () => Promise<Parsed<unknown>>) => Promise<RouteAnswer | null>
  /** GET /memory/sessions and /memory/sessions/:id/turns (the dashboard's Sessions view); null for any other path. Absent: those paths are 404. */
  sessions?: (method: string, url: URL) => RouteAnswer | null
  /** GET /watch (token only): the prompts since a cursor with what was recalled for each, for `kinfold watch`. Absent: 404. */
  watch?: (method: string, url: URL) => RouteAnswer
  /** GET /watch/debug (token only): the in-memory trace `kinfold watch --debug` prints. Absent: 404. */
  debugWatch?: (method: string, url: URL) => RouteAnswer
  /** POST /metrics/mcp-read: one MCP tool call reported by the read-only MCP server (token only). */
  mcpRead: (read: McpRead) => number
  /** POST /observer/test: one fixed prompt through the chosen runner. */
  observerTest: ObserverTestRoute
  /** GET and PUT /embedding/settings; absent in a daemon built without it. */
  embeddingSettings?: EmbeddingRoute
  /** GET /observer/models: the installed CLI's model names, cached for ten minutes. */
  observerModels: ObserverModelsRoute
  /** Leases, login codes and session cookies for the dashboard. */
  auth: DashboardAuth
  /** What `kinfold dashboard` prints while it runs; absent, a log no command reads. */
  dashboardEvents?: DashboardEvents
  /** A browser signed in to the dashboard: for the Activity page. */
  onSignIn?: () => void
  /** The service's log file, offered on the Activity page; absent, the download is 404. */
  daemonLogPath?: string
  /** A central device's own events, kept in memory; empty elsewhere. */
  deviceActivity?: () => unknown[]
  /** The /read/ routes (token only); absent, every /read/ path is 404. */
  reads?: ReadRouteDeps
  /** GET /backup, POST /restore/upload, POST /restore, POST /restore/undo, GET /restore/status; absent, each is 404. */
  backup?: BackupRoutes
  /** Why the store cannot be reached right now (a restore is replacing it), or null. Routes that read or write it answer 503 meanwhile. */
  unavailable?: () => string | null
  /** A central device: reads and recall answer through the hub, and changes to stored memory are refused. Absent: local. */
  device?: DeviceRouting
  /** GET /central/status: this daemon's central mode and how it is going; `check` asks the hub first. Absent reads as local. */
  centralStatus?: (check: boolean) => unknown
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
const UNDO_PATH = '/restore/undo'
const BACKUP_PATHS: ReadonlySet<string> = new Set(['/backup', '/restore', UPLOAD_PATH, UNDO_PATH, '/restore/status'])

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

/** GET, PUT and DELETE /observer/claude-token: answers only which login is in use, never the token. */
async function claudeTokenRoute(request: Request, handlers: ObserverSettingsHandlers): Promise<Response> {
  const token = handlers.token
  if (token === null) return json(503, { error: 'this daemon has no key store to keep a token in' })
  if (request.method === 'GET') return json(200, { auth: token.auth() })
  if (request.method === 'DELETE') {
    token.remove()
    return json(200, { auth: token.auth() })
  }
  if (request.method !== 'PUT') return json(405, { error: 'method not allowed' })
  const body = await readJson(request)
  const parsed = body.ok ? parseTokenPut(body.value) : body
  if (!parsed.ok) return json(400, { error: parsed.error })
  token.save(parsed.value)
  return json(200, { auth: token.auth() })
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

async function route(request: Request, url: URL, deps: ServerDeps, via: Credential): Promise<Response> {
  if (url.pathname === '/observer/settings') return observerSettingsRoute(request, deps.observerSettings)
  if (url.pathname === '/observer/claude-token') return claudeTokenRoute(request, deps.observerSettings)
  if (url.pathname === '/observer/recheck') {
    return postJson(request, parseRecheck, (provider) => json(200, { ok: true, cleared: deps.observerSettings.recheck(provider) }))
  }
  if (url.pathname === '/search/semantic') return semanticRoute(request, deps)
  if (url.pathname === '/embedding/settings' && deps.embeddingSettings !== undefined) {
    const answered = await deps.embeddingSettings(request.method, () => readJson(request))
    return json(answered.status, answered.body)
  }
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
  if (url.pathname === '/watch/debug' && deps.debugWatch !== undefined) {
    const answer = deps.debugWatch(request.method, url)
    return json(answer.status, answer.body)
  }
  if (url.pathname === '/watch' && deps.watch !== undefined) {
    const answer = deps.watch(request.method, url)
    return json(answer.status, answer.body)
  }
  if (url.pathname === '/sessions') {
    if (request.method !== 'GET') return json(405, { error: 'method not allowed' })
    const sessions = deps.listSessions(url.searchParams.get('project'))
    return json(200, { sessions })
  }
  const answer = await panelRoute(request, url, deps, via)
  return answer === null ? json(404, { error: 'not found' }) : json(answer.status, answer.body)
}

/** The routes the dashboard reads and writes besides /observer/settings: data control, memory, metrics, model test. */
async function panelRoute(request: Request, url: URL, deps: ServerDeps, via: Credential): Promise<RouteAnswer | null> {
  const path = url.pathname
  if (path.startsWith('/data/')) return dataRoute(request.method, url, () => readJson(request), deps.data, deps.exclusive)
  if (path.startsWith('/memory/')) return deps.sessions?.(request.method, url) ?? memoryRoute(request.method, url, deps.memory)
  if (path === '/observer/models') return deps.observerModels(request.method, url)
  if (path === '/observer/test') return deps.observerTest(request.method, () => readJson(request))
  if (path === '/update') return request.method === 'GET' ? { status: 200, body: { notice: deps.update?.banner(via === 'cookie') ?? null, auto: deps.update?.auto() ?? null, ...(deps.update?.view() ?? {}) } } : { status: 405, body: { error: 'method not allowed' } }
  if (path === '/update/settings') return updateSettingsRoute(request, deps.update)
  if (path === '/update/install') return installRoute(request, deps.update)
  if (path === '/update/auto') return autoUpdateRoute(request, deps.update)
  if (path === '/update/quiet' && deps.update !== undefined) return request.method === 'GET' ? { status: 200, body: { quietForMs: deps.update.quietForMs() } } : { status: 405, body: { error: 'method not allowed' } }
  if (path.startsWith('/projects') && deps.projects !== undefined) {
    const answer = await deps.projects(request.method, url, () => readJson(request))
    if (answer !== null) return answer
  }
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
  if (path === UNDO_PATH) return answered(routes.undo())
  return answered(path === UPLOAD_PATH ? await routes.upload(request) : await routes.start(() => readJson(request)))
}

/** Seconds a client should wait before asking again while the store is closed: a restore reopens it within moments. */
const RETRY_AFTER_SECONDS = '1'

function storeClosed(message: string): Response {
  const response = json(503, { error: message })
  response.headers.set('retry-after', RETRY_AFTER_SECONDS)
  return response
}

async function storeRoute(request: Request, url: URL, deps: ServerDeps, via: Credential): Promise<Response> {
  const down = deps.unavailable?.() ?? null
  if (down !== null) return storeClosed(down)
  try {
    return await route(request, url, deps, via)
  } catch (error: unknown) {
    // Started before a restore closed the store, then met the closed connection: the same answer as arriving a moment later.
    const closed = deps.unavailable?.() ?? null
    if (closed !== null) return storeClosed(closed)
    throw error
  }
}

export interface UpdateHandlers {
  /**
   * The banner the dashboard shows; null means none. With `markShown`, "updated
   * itself" is marked as seen, so it shows once: only the dashboard's own
   * session asks that way, so a script reading with the token never uses it up.
   * A release to install by hand is never marked.
   */
  banner(markShown: boolean): { version: string; message: string } | null
  /** How long it has been since anything but an update question reached the daemon: what the updater waits on before it installs. */
  quietForMs(): number
  /** Whether patch releases install themselves, why not, and how the last attempt went. */
  auto(): AutoUpdateView
  /** Saves the switch in install.json; false when this data folder has no install record to hold it. */
  setAuto(enabled: boolean): boolean
  /** The release on offer with its change lines, the updates settings and the dashboard install's progress. */
  view(): { release: UpdateRelease | null; settings: UpdateSettings; install: InstallRun | null }
  /** Saves the level and beta in install.json; false when there is no install record. */
  setSettings(settings: UpdateSettings): boolean
  /** Starts the staged install of `version` detached; a refusal names why. */
  install(version: string): RouteAnswer
  /** The dashboard install's progress and the version this daemon runs, which the page watches change. */
  installState(): { running: string; install: InstallRun | null }
}

export interface UpdateSettings {
  level: UpdateLevel
  beta: boolean
}

export interface UpdateRelease {
  version: string
  changes: string[]
  breaking: string[]
  /** Its program is downloaded and checked. */
  staged: boolean
  /** The Install button can install it here. */
  installable: boolean
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** GET /update/settings reads the level and beta; PUT {"level": "off"|"notify"|"patch", "beta": boolean} sets both. */
async function updateSettingsRoute(request: Request, handlers: UpdateHandlers | undefined): Promise<RouteAnswer | null> {
  if (handlers === undefined) return null
  if (request.method === 'GET') return { status: 200, body: { settings: handlers.view().settings } }
  if (request.method !== 'PUT') return { status: 405, body: { error: 'method not allowed' } }
  const body = await readJson(request)
  if (!body.ok) return { status: 400, body: { error: body.error } }
  const value = isObject(body.value) ? body.value : {}
  if (!isUpdateLevel(value.level) || typeof value.beta !== 'boolean') return { status: 400, body: { error: 'body must be {"level": "off"|"notify"|"patch", "beta": true|false}' } }
  if (!handlers.setSettings({ level: value.level, beta: value.beta })) return { status: 409, body: { error: 'this data folder has no install record; run kinfold install first' } }
  return { status: 200, body: { settings: handlers.view().settings } }
}

/** GET /update/install reads how the dashboard install is going; POST {"version": "<x.y.z>"} starts it. */
async function installRoute(request: Request, handlers: UpdateHandlers | undefined): Promise<RouteAnswer | null> {
  if (handlers === undefined) return null
  if (request.method === 'GET') return { status: 200, body: handlers.installState() }
  if (request.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }
  const body = await readJson(request)
  if (!body.ok) return { status: 400, body: { error: body.error } }
  const version = isObject(body.value) ? body.value.version : undefined
  // It becomes an argument of the updater's command line, so only a version passes.
  if (typeof version !== 'string' || parseVersion(version) === null) return { status: 400, body: { error: 'body must be {"version": "<the release on offer>"}' } }
  return handlers.install(version)
}

/** GET /update/auto reads the switch; PUT {"enabled": boolean} sets it. */
async function autoUpdateRoute(request: Request, handlers: UpdateHandlers | undefined): Promise<RouteAnswer | null> {
  if (handlers === undefined) return null
  // The data page reads here, so its read never uses up the banner's once-only notice.
  if (request.method === 'GET') return { status: 200, body: { auto: handlers.auto() } }
  if (request.method !== 'PUT') return { status: 405, body: { error: 'method not allowed' } }
  const body = await readJson(request)
  if (!body.ok) return { status: 400, body: { error: body.error } }
  const enabled = typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value) ? (body.value as { enabled?: unknown }).enabled : undefined
  if (typeof enabled !== 'boolean') return { status: 400, body: { error: 'body must be {"enabled": true} or {"enabled": false}' } }
  if (!handlers.setAuto(enabled)) return { status: 409, body: { error: 'this data folder has no install record; run kinfold install first' } }
  return { status: 200, body: { auto: handlers.auto() } }
}

const DASHBOARD_PAGES = new Set(['/dashboard', '/dashboard/'])

/** Closed for this browser: its own command ended, or no command runs at all. A browser that never signed in, with a dashboard open, only needs a sign-in. */
function isClosedFor(request: Request, auth: DashboardAuth): boolean {
  return auth.sessionState(sessionFromCookie(request.headers.get('cookie'))) === 'closed' || !auth.isOpen()
}

/**
 * A signed-out browser opening the app page goes to the login page, which
 * explains `kinfold dashboard`. With no command holding a lease the dashboard
 * is closed, and a request without the token says so, so an open page can
 * tell the reader why it stopped.
 */
function refused(request: Request, path: string, access: Access, result: Extract<AccessResult, { ok: false }>, deps: ServerDeps): Response {
  const closed = result.status === 401 && access !== 'token' && request.headers.get('authorization') === null && isClosedFor(request, deps.auth)
  if (access === 'cookie' && result.status === 401 && request.method === 'GET' && DASHBOARD_PAGES.has(path)) {
    return new Response(null, { status: 303, headers: { location: closed ? '/dashboard/login#closed' : '/dashboard/login' } })
  }
  if (result.status === 403) deps.log(`request refused status=403 reason=origin method=${request.method}`)
  return closed ? json(401, { error: CLOSED_MESSAGE, closed: true }) : json(result.status, { error: result.error })
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

/**
 * The updater, `kinfold status` and the dashboard's banner ask these; asking
 * must not itself keep an update waiting. Nor must a watcher: `kinfold watch`
 * (with or without --debug) and OpenCode's toast poll /watch once a second for as long as they are
 * open, which would otherwise mean the daemon is never quiet.
 */
function isUpdateQuestion(path: string): boolean {
  return path === '/update' || path.startsWith('/update/') || path === '/watch' || path === '/watch/debug'
}

/** `kinfold dashboard`'s heartbeat and the page's open-or-closed check come every few seconds; neither is someone at work. */
function isDashboardPulse(path: string): boolean {
  return path === '/dashboard/state' || path.startsWith(LEASE_PREFIX)
}

/**
 * `kinfold status` and `kinfold install` read the observer settings with the
 * token; a person running them is not an agent at work. The dashboard reads
 * the same route with its cookie, and a change through either still counts.
 */
function isQuietRead(request: Request, path: string, via: Credential): boolean {
  return isUpdateQuestion(path) || isDashboardPulse(path) || (path === '/observer/settings' && request.method === 'GET' && via === 'token')
}

const unreadEvents = new WeakMap<ServerDeps, DashboardEvents>()

function dashboardEvents(deps: ServerDeps): DashboardEvents {
  if (deps.dashboardEvents !== undefined) return deps.dashboardEvents
  const kept = unreadEvents.get(deps) ?? createDashboardEvents()
  unreadEvents.set(deps, kept)
  return kept
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
  if (!isQuietRead(request, url.pathname, checked.via)) deps.onActivity?.()
  // Every route but the upload keeps the 16 KB limit Bun's cap used to give it, body-reading or not.
  if (url.pathname !== UPLOAD_PATH && declaredLength(request) > MAX_BODY_BYTES) return json(413, { error: 'body too large' })
  const startedAt = performance.now()
  if (url.pathname === '/central/status') return request.method === 'GET' ? json(200, (await deps.centralStatus?.(url.searchParams.get('check') === '1')) ?? { role: 'local' }) : json(405, { error: 'method not allowed' })
  const isDashboardPath = url.pathname === '/dashboard' || url.pathname.startsWith('/dashboard/')
  if (deps.device !== undefined && !isDashboardPath) {
    const routed = await deviceRoute(request.method, url, () => readJson(request), deps.device)
    if (routed !== null) return json(routed.status, routed.body)
  }
  const dashboard = isDashboardPath
    ? await dashboardRoute(request, url.pathname, { port, auth: deps.auth, readBody: () => readJson(request), events: dashboardEvents(deps), log: deps.log, ...(deps.onSignIn !== undefined ? { onSignIn: deps.onSignIn } : {}), ...(deps.daemonLogPath !== undefined ? { daemonLogPath: deps.daemonLogPath } : {}), ...(deps.deviceActivity !== undefined ? { deviceActivity: deps.deviceActivity } : {}) })
    : undefined
  const other = (): Promise<Response> => (BACKUP_PATHS.has(url.pathname) ? backupRoute(request, url.pathname, deps) : storeRoute(request, url, deps, checked.via))
  const response = dashboard === undefined ? await other() : (dashboard ?? json(404, { error: 'not found' }))
  // Route, status and time only: no query string, body or cookie.
  if (checked.via === 'cookie' && !isDashboardPulse(url.pathname)) {
    const ms = Math.round(performance.now() - startedAt)
    deps.log(`dashboard ${request.method} ${url.pathname} status=${response.status} ms=${ms}`)
    dashboardEvents(deps).request(request.method, url.pathname, response.status, ms)
  }
  return response
}

export async function handleRequest(request: Request, port: number, deps: ServerDeps): Promise<Response> {
  return withSecurityHeaders(await answer(request, port, deps))
}

/** Seconds a request may go without a byte either way before the server drops it. */
export const SERVER_IDLE_TIMEOUT_S = 30

/** The path with numeric segments folded, so a stall line names the route and never an id or a query. */
export function routeLabel(requestUrl: string): string {
  let path: string
  try {
    path = new URL(requestUrl).pathname
  } catch {
    return 'route ?'
  }
  return `route ${path.split('/').map((segment) => (/^\d+$/.test(segment) ? ':id' : segment)).join('/').slice(0, 80)}`
}

export function startServer(deps: ServerDeps): RunningServer {
  const server = Bun.serve({
    hostname: LOOPBACK_HOST,
    port: deps.port,
    // Server-wide, so it is the upload's ceiling; every other route is held to MAX_BODY_BYTES in answer() and readJson.
    maxRequestBodySize: MAX_UPLOAD_BYTES,
    // Past every client's own wait (the CLI waits 15 s): Bun's 10 s default dropped a slow report's connection, which the CLI could only call a TypeError.
    idleTimeout: SERVER_IDLE_TIMEOUT_S,
    fetch: (request, self) => {
      const handle = (): Promise<Response> => handleRequest(request, self.port ?? deps.port, deps)
      return deps.step === undefined ? handle() : deps.step(routeLabel(request.url), handle)
    },
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
