// Test scaffolding for the dashboard: a daemon on a temp data dir, the
// token it wrote, and the login exchange a browser would do (code, then
// session cookie). Tests only; nothing in the daemon imports it.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type DaemonOptions, type RunningDaemon, startDaemon } from '../daemon/daemon'

export interface DashboardRig {
  daemon: RunningDaemon
  token: string
  logs: string[]
  origin: string
  url: (path: string) => string
  /** A request as our page sends it: cookie, Origin and X-SAM-Request, unless overridden. */
  page: (method: string, path: string, options?: PageOptions) => Promise<Response>
  /** A request with the Bearer token, as the CLI sends it. */
  bearer: (method: string, path: string, body?: unknown) => Promise<Response>
  /** Runs the whole login: code with the token, then session with the code; returns the cookie pair. */
  login: () => Promise<string>
  stop: () => Promise<void>
}

export interface PageOptions {
  cookie?: string | null
  body?: unknown
  headers?: Record<string, string>
  /** Leave out Origin and X-SAM-Request. */
  bare?: boolean
}

export function cookiePair(setCookie: string | null): string {
  const pair = (setCookie ?? '').split(';')[0] ?? ''
  if (!pair.startsWith('sam_session=')) throw new Error('no session cookie was set')
  return pair
}

export function startRig(dataDir: string, options: Partial<DaemonOptions> = {}): DashboardRig {
  const logs: string[] = []
  const daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), ...options })
  const token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()
  const origin = `http://127.0.0.1:${daemon.port}`
  const url = (path: string): string => `${origin}${path}`
  const withBody = (body: unknown): RequestInit => (body === undefined ? {} : { body: JSON.stringify(body) })
  const page = (method: string, path: string, opts: PageOptions = {}): Promise<Response> => fetch(url(path), {
    method,
    redirect: 'manual',
    headers: {
      ...(opts.bare === true ? {} : { origin, 'x-sam-request': '1' }),
      ...(opts.cookie !== undefined && opts.cookie !== null ? { cookie: opts.cookie } : {}),
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...opts.headers,
    },
    ...withBody(opts.body),
  })
  const bearer = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(url(path), { method, redirect: 'manual', headers: { authorization: `Bearer ${token}` }, ...withBody(body) })
  const login = async (): Promise<string> => {
    const issued = (await (await bearer('POST', '/dashboard/login-code')).json()) as { code: string }
    const session = await page('POST', '/dashboard/session', { body: { code: issued.code } })
    if (session.status !== 204) throw new Error(`session answered ${session.status}`)
    return cookiePair(session.headers.get('set-cookie'))
  }
  return { daemon, token, logs, origin, url, page, bearer, login, stop: () => daemon.stop() }
}
