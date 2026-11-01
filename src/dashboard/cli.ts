// `sam dashboard [--print]`: trades the daemon token (read from the data
// dir, like every CLI command) for a one-time login code, then opens
// http://127.0.0.1:<port>/dashboard/login#code=<code> in the browser, or
// prints it with --print. The code sits in the URL fragment, which browsers
// never send in a request or a Referer; it works once, within 60 s, and the
// login page drops it from the address bar. The token itself never leaves
// this process. Output is the URL or a one-line error.

import { isRecord } from '../contract/event'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import type { DashboardArgs } from '../install/args'
import type { InstallEnv } from '../install/env'

export type DashboardCliEnv = Pick<InstallEnv, 'dataDir' | 'fetch' | 'out' | 'run' | 'platform'>

const EXIT_OK = 0
const EXIT_FAILED = 1
const REQUEST_TIMEOUT_MS = 5_000
const OPEN_TIMEOUT_MS = 10_000
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/
const OPENERS: Readonly<Partial<Record<NodeJS.Platform, string>>> = { darwin: 'open', linux: 'xdg-open' }

export function loginUrl(port: number, code: string): string {
  return `http://127.0.0.1:${port}/dashboard/login#code=${code}`
}

type CodeAnswer = { ok: true; port: number; code: string } | { ok: false; error: string }

async function requestCode(env: DashboardCliEnv): Promise<CodeAnswer> {
  const endpoint = readDaemonEndpoint(env.dataDir)
  if (endpoint === null) return { ok: false, error: 'the daemon is not running (no daemon.json or daemon.token)' }
  try {
    const response = await env.fetch(`http://127.0.0.1:${endpoint.port}/dashboard/login-code`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (response.status === 404) return { ok: false, error: 'the running daemon is an older build without the dashboard' }
    if (response.status !== 200) return { ok: false, error: `POST /dashboard/login-code answered ${response.status}` }
    const body: unknown = await response.json()
    if (!isRecord(body) || typeof body.code !== 'string' || !CODE_PATTERN.test(body.code)) return { ok: false, error: 'unexpected login-code answer' }
    return { ok: true, port: endpoint.port, code: body.code }
  } catch (error: unknown) {
    return { ok: false, error: `POST /dashboard/login-code failed (${error instanceof Error ? error.name : 'error'})` }
  }
}

export async function runDashboard(env: DashboardCliEnv, args: DashboardArgs): Promise<number> {
  const answer = await requestCode(env)
  if (!answer.ok) {
    env.out(`sam dashboard failed: ${answer.error}`)
    return EXIT_FAILED
  }
  const url = loginUrl(answer.port, answer.code)
  const opener = OPENERS[env.platform]
  if (args.print || opener === undefined) {
    env.out(url)
    return EXIT_OK
  }
  const opened = await env.run({ argv: [opener, url], timeoutMs: OPEN_TIMEOUT_MS })
  if (opened.exitCode !== 0) {
    env.out(`could not open a browser (${opener} exited ${opened.exitCode}); open this link within 60 s:`)
    env.out(url)
    return EXIT_OK
  }
  env.out('opened the dashboard in your browser; the link works once, within 60 s')
  return EXIT_OK
}
