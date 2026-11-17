// `kinfold dashboard [--print | --close]`. The dashboard is open only while
// this command runs. It holds a lease on the daemon (renewed every second; it
// lapses 15 s after the last renewal, so a killed terminal closes the
// dashboard on its own), offers the daemon one sign-in under that lease, and
// opens the browser at the plain address
// http://127.0.0.1:<port>/dashboard/login. The login page claims the offer
// (once, within 60 s, only from this daemon's own origin), so no code or
// token travels in a URL, a process's arguments or the terminal on any
// platform. While running, each renewal brings back the dashboard's log,
// which is printed: requests by method, path, status and time, and steps
// such as a sign-in or a backup. Ctrl-C, a closed terminal or SIGTERM ends
// the lease, which signs out every page it opened.
//
// --print is for scripts and for a browser on another machine through an SSH
// tunnel, where no offer could reach the right browser: it prints a link with
// a one-time code in its fragment (single use, 60 s), holds a 12 h lease and
// exits. --close ends the leases --print holds. The token itself never leaves
// this process.

import { randomBytes } from 'node:crypto'
import { isRecord } from '../contract/event'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import type { DashboardArgs } from '../install/args'
import type { CommandRequest, InstallEnv } from '../install/env'
import type { LeaseMode } from './auth'
import type { DashboardEvent } from './events'

export type DashboardCliEnv = Pick<InstallEnv, 'dataDir' | 'fetch' | 'out' | 'run' | 'platform' | 'sleep'> & Partial<Pick<InstallEnv, 'ui'>>

export interface DashboardDeps {
  /** Aborted by Ctrl-C, SIGHUP or SIGTERM; the command then ends its lease and exits 0. */
  stop?: AbortSignal
  pollMs?: number
}

const EXIT_OK = 0
const EXIT_FAILED = 1
export const DASHBOARD_POLL_MS = 1_000
const REQUEST_TIMEOUT_MS = 5_000
const OPEN_TIMEOUT_MS = 10_000
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const LEASE_BYTES = 32
export const SIGNED_OUT = 'Signed out; the dashboard is closed.'
const OFFER_SECONDS = 60

type Endpoint = { port: number; token: string }

export function loginUrl(port: number, code: string): string {
  return `http://127.0.0.1:${port}/dashboard/login#code=${code}`
}

export function plainLoginUrl(port: number): string {
  return `http://127.0.0.1:${port}/dashboard/login`
}

/**
 * Each platform's own way to open an address in the default browser. The
 * address is plain, so nothing here needs keeping out of argv. Windows uses
 * the URL handler directly: `start` is a cmd built-in, and going through cmd
 * would need its quoting.
 */
const OPENERS: Readonly<Partial<Record<NodeJS.Platform, (url: string) => CommandRequest>>> = {
  darwin: (url) => ({ argv: ['open', url], timeoutMs: OPEN_TIMEOUT_MS }),
  linux: (url) => ({ argv: ['xdg-open', url], timeoutMs: OPEN_TIMEOUT_MS }),
  win32: (url) => ({ argv: ['rundll32', 'url.dll,FileProtocolHandler', url], timeoutMs: OPEN_TIMEOUT_MS }),
}

export function openRequest(platform: NodeJS.Platform, url: string): CommandRequest | null {
  return OPENERS[platform]?.(url) ?? null
}

function newLeaseId(): string {
  return randomBytes(LEASE_BYTES).toString('base64url')
}

function signalFor(stop: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  return stop === undefined ? timeout : AbortSignal.any([timeout, stop])
}

async function call(env: DashboardCliEnv, endpoint: Endpoint, method: string, path: string, body?: unknown, stop?: AbortSignal): Promise<Response> {
  return env.fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${endpoint.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    signal: signalFor(stop),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

type Position = { epoch: string; cursor: number }

/** `waits`: the daemon did not answer or failed for now, so the command waits; any other refusal ends it. */
type Held = { ok: true; at: Position; events: readonly DashboardEvent[] } | { ok: false; error: string; waits: boolean }

const OLDER_BUILD = 'the running daemon is an older build; run kinfold update'

function parseEvent(value: unknown): DashboardEvent | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.at)) return null
  if (value.kind === 'event' && typeof value.text === 'string') return { id: value.id as number, at: value.at as number, kind: 'event', text: value.text }
  if (value.kind === 'request' && typeof value.method === 'string' && typeof value.path === 'string' && Number.isSafeInteger(value.status) && Number.isSafeInteger(value.ms)) {
    return { id: value.id as number, at: value.at as number, kind: 'request', method: value.method, path: value.path, status: value.status as number, ms: value.ms as number }
  }
  return null
}

async function holdLease(env: DashboardCliEnv, endpoint: Endpoint, lease: string, mode: LeaseMode, at: Position | null, stop?: AbortSignal): Promise<Held> {
  try {
    const query = at === null ? '' : `?${new URLSearchParams({ after: String(at.cursor), epoch: at.epoch })}`
    const response = await call(env, endpoint, 'PUT', `/dashboard/lease/${lease}${query}`, { mode }, stop)
    // A daemon from before leases has no lease route; there /dashboard/* takes only the cookie, so the token is refused.
    if (response.status === 404 || (response.status === 401 && at === null)) return { ok: false, error: OLDER_BUILD, waits: false }
    if (response.status !== 200) {
      const body: unknown = await response.json().catch(() => null)
      const error = isRecord(body) && typeof body.error === 'string' ? body.error : `the lease answered ${response.status}`
      return { ok: false, error, waits: response.status >= 500 }
    }
    const body: unknown = await response.json()
    if (!isRecord(body) || !Number.isSafeInteger(body.cursor) || typeof body.epoch !== 'string' || !Array.isArray(body.events)) return { ok: false, error: 'unexpected lease answer', waits: false }
    return { ok: true, at: { epoch: body.epoch, cursor: body.cursor as number }, events: body.events.flatMap((event) => parseEvent(event) ?? []) }
  } catch (error: unknown) {
    return { ok: false, error: `the daemon did not answer (${error instanceof Error ? error.name : 'error'})`, waits: true }
  }
}

type CodeAnswer = { ok: true; code: string } | { ok: false; error: string }

async function requestCode(env: DashboardCliEnv, endpoint: Endpoint, lease: string): Promise<CodeAnswer> {
  try {
    const response = await call(env, endpoint, 'POST', '/dashboard/login-code', { lease })
    if (response.status !== 200) return { ok: false, error: `POST /dashboard/login-code answered ${response.status}` }
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.code !== 'string' || !CODE_PATTERN.test(body.code)) return { ok: false, error: 'unexpected login-code answer' }
    return { ok: true, code: body.code }
  } catch (error: unknown) {
    return { ok: false, error: `POST /dashboard/login-code failed (${error instanceof Error ? error.name : 'error'})` }
  }
}

function clock(at: number): string {
  const date = new Date(at)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':')
}

/** `HH:MM:SS  GET /memory/facets 200 4ms`, or `HH:MM:SS  signed in from a browser`. */
export function eventLine(event: DashboardEvent): string {
  const what = event.kind === 'event' ? event.text : `${event.method} ${event.path} ${event.status} ${event.ms}ms`
  return `${clock(event.at)}  ${what}`
}

/** Resolves after `ms`, or at once when the command is stopped. */
function pause(env: DashboardCliEnv, ms: number, stop: AbortSignal | undefined): Promise<void> {
  if (stop === undefined) return env.sleep(ms)
  if (stop.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      stop.removeEventListener('abort', done)
      resolve()
    }
    stop.addEventListener('abort', done)
    void env.sleep(ms).then(done)
  })
}

async function openBrowser(env: DashboardCliEnv, url: string): Promise<readonly string[]> {
  const request = openRequest(env.platform, url)
  const opened = request === null ? null : await env.run(request)
  if (opened?.exitCode === 0) return ['opened the dashboard in your browser, signed in']
  return [`could not open a browser here; open this address within ${OFFER_SECONDS} s and it signs in:`, url]
}

async function offerSignIn(env: DashboardCliEnv, endpoint: Endpoint, lease: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await call(env, endpoint, 'POST', '/dashboard/offer', { lease })
    return response.status === 200 ? { ok: true } : { ok: false, error: `POST /dashboard/offer answered ${response.status}` }
  } catch (error: unknown) {
    return { ok: false, error: `POST /dashboard/offer failed (${error instanceof Error ? error.name : 'error'})` }
  }
}

async function release(env: DashboardCliEnv, dataDir: string, lease: string): Promise<boolean> {
  const endpoint = readDaemonEndpoint(dataDir)
  if (endpoint === null) return false
  try {
    return (await call(env, endpoint, 'DELETE', `/dashboard/lease/${lease}`)).status === 200
  } catch {
    return false
  }
}

async function runForeground(env: DashboardCliEnv, endpoint: Endpoint, deps: DashboardDeps, fail: (reason: string) => number): Promise<number> {
  const lease = newLeaseId()
  const first = await holdLease(env, endpoint, lease, 'live', null)
  if (!first.ok) return fail(first.error)
  const offered = await offerSignIn(env, endpoint, lease)
  if (!offered.ok) {
    await release(env, env.dataDir, lease)
    return fail(offered.error)
  }
  env.out(`dashboard open at http://127.0.0.1:${endpoint.port}/dashboard/ while this runs; Ctrl-C closes it`)
  for (const line of await openBrowser(env, plainLoginUrl(endpoint.port))) env.out(line)

  let at = first.at
  let waiting = false
  let refused: string | null = null
  const stopped = (): boolean => deps.stop?.aborted === true
  while (!stopped()) {
    await pause(env, deps.pollMs ?? DASHBOARD_POLL_MS, deps.stop)
    if (stopped()) break
    // Read each time: a daemon restarted by an update may listen on another port with another token; the same lease id is held again there.
    const now = readDaemonEndpoint(env.dataDir)
    const held: Held = now === null ? { ok: false, error: 'down', waits: true } : await holdLease(env, now, lease, 'live', at, deps.stop)
    if (stopped()) break
    if (!held.ok && !held.waits) {
      refused = held.error
      break
    }
    if (!held.ok) {
      if (!waiting) env.out('the daemon is not answering; waiting for it, Ctrl-C to stop')
      waiting = true
      continue
    }
    if (waiting) env.out('the daemon is back')
    waiting = false
    at = held.at
    for (const event of held.events) env.out(eventLine(event))
  }
  const released = await release(env, env.dataDir, lease)
  if (refused !== null) return fail(refused)
  const last = released ? SIGNED_OUT : 'the daemon did not answer; the dashboard closes on its own within 15 s'
  // On a terminal it is the frame's closing line; in a pipe it is the last line.
  if (env.ui !== undefined) env.ui.next(last)
  else env.out(last)
  return EXIT_OK
}

async function runPrint(env: DashboardCliEnv, endpoint: Endpoint, fail: (reason: string) => number): Promise<number> {
  const lease = newLeaseId()
  const held = await holdLease(env, endpoint, lease, 'print', null)
  if (!held.ok) return fail(held.error)
  const code = await requestCode(env, endpoint, lease)
  if (!code.ok) {
    // Without a code nobody can sign in, so the 12 h lease would only hold the dashboard open and take a slot.
    await release(env, env.dataDir, lease)
    return fail(code.error)
  }
  env.out(loginUrl(endpoint.port, code.code))
  env.out('the dashboard stays open until `kinfold dashboard --close` or for 12 hours; the link works once, within 60 s')
  return EXIT_OK
}

async function runClose(env: DashboardCliEnv, endpoint: Endpoint, fail: (reason: string) => number): Promise<number> {
  try {
    const response = await call(env, endpoint, 'POST', '/dashboard/close')
    if (response.status !== 200) return fail(`POST /dashboard/close answered ${response.status}`)
    const body: unknown = await response.json()
    const closed = isRecord(body) && Number.isSafeInteger(body.closed) ? (body.closed as number) : 0
    env.out(closed > 0 ? 'closed the dashboard opened with --print' : 'no dashboard opened with --print was open')
    return EXIT_OK
  } catch (error: unknown) {
    return fail(`POST /dashboard/close failed (${error instanceof Error ? error.name : 'error'})`)
  }
}

export async function runDashboard(env: DashboardCliEnv, args: DashboardArgs, deps: DashboardDeps = {}): Promise<number> {
  const fail = (reason: string): number => {
    ;(env.ui?.error ?? env.out)(`kinfold dashboard failed: ${reason}`)
    return EXIT_FAILED
  }
  const endpoint = readDaemonEndpoint(env.dataDir)
  if (endpoint === null) return fail('the daemon is not running (no daemon.json or daemon.token)')
  if (args.close) return runClose(env, endpoint, fail)
  if (args.print) return runPrint(env, endpoint, fail)
  return runForeground(env, endpoint, deps, fail)
}
