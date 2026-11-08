// The installer's view of the daemon: is something answering /health on the
// port daemon.json names (or the default port), and the authenticated GET and
// PUT on /observer/settings. The installer never opens the database; a
// settings change goes through the daemon like the dashboard's will.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../contract/event'
import { DEFAULT_PORT } from '../daemon/daemon'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import type { ObserverSettingsView } from '../daemon/settings-route'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import { DAEMON_INFO_FILE } from '../store/data-dir'
import type { InstallEnv } from './env'
import type { ServiceControl } from './service/control'

const HEALTH_TIMEOUT_MS = 1_000
const REQUEST_TIMEOUT_MS = 5_000
const HEALTH_POLL_MS = 250
const RUNNING_CHECK_MS = 5_000

/** A large store keeps a started daemon from answering while it drains the spool, runs observers and rebuilds packs. */
export const START_WAIT_MS = 180_000
export const START_PROGRESS_MS = 15_000

export interface DaemonInfoFile {
  pid: number | null
  port: number
}

/**
 * hmacMode: master, legacy or degraded; null from a daemon too old to report it.
 * vectorSearch: whether sqlite-vec loaded; absent from a daemon before vector search.
 */
export type Health = { up: true; version: string; schemaVersion: number; hmacMode: string | null; vectorSearch?: 'on' | 'off' } | { up: false; reason: string }

/** daemon.json's pid and port; the default port when the file is missing or unreadable. */
export function readDaemonInfo(dataDir: string): DaemonInfoFile {
  const path = join(dataDir, DAEMON_INFO_FILE)
  try {
    const info: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    if (!isRecord(info)) return { pid: null, port: DEFAULT_PORT }
    const port = typeof info.port === 'number' && Number.isInteger(info.port) && info.port > 0 ? info.port : DEFAULT_PORT
    return { pid: typeof info.pid === 'number' ? info.pid : null, port }
  } catch {
    return { pid: null, port: DEFAULT_PORT }
  }
}

export async function checkHealth(env: InstallEnv, port: number): Promise<Health> {
  try {
    const response = await env.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (response.status !== 200) return { up: false, reason: `health answered ${response.status}` }
    const body: unknown = await response.json()
    if (!isRecord(body) || body.ok !== true) return { up: false, reason: 'health body is not ours' }
    const hmacMode = typeof body.hmacMode === 'string' ? body.hmacMode : null
    const vectorSearch = body.vectorSearch
    const vectors: { vectorSearch?: 'on' | 'off' } = vectorSearch === 'on' || vectorSearch === 'off' ? { vectorSearch } : {}
    return { up: true, version: String(body.version), schemaVersion: Number(body.schemaVersion), hmacMode, ...vectors }
  } catch (error: unknown) {
    return { up: false, reason: `nothing answers on 127.0.0.1:${port} (${error instanceof Error ? error.name : 'error'})` }
  }
}

/** Polls the port daemon.json names until /health answers `up` as wanted, or the timeout passes. */
export async function waitForHealth(env: InstallEnv, wantUp: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = env.now() + timeoutMs
  for (;;) {
    const health = await checkHealth(env, readDaemonInfo(env.dataDir).port)
    if (health.up === wantUp) return true
    if (env.now() >= deadline) return false
    await env.sleep(HEALTH_POLL_MS)
  }
}

export type StartWait = { ok: true; waitedMs: number } | { ok: false; reason: 'timeout' | 'not-running' }

async function serviceStopped(service: ServiceControl | null): Promise<boolean> {
  if (service === null) return false
  try {
    return !(await service.isRunning())
  } catch {
    return false
  }
}

/**
 * Waits for /health after a start. A progress line every START_PROGRESS_MS says
 * what the daemon is busy with. The wait ends early when the OS no longer has
 * the service loaded, since nothing will answer then; the timeout stays as the
 * backstop for a service that stays loaded but keeps exiting.
 */
export async function waitForStart(env: InstallEnv, service: ServiceControl | null, timeoutMs: number = START_WAIT_MS): Promise<StartWait> {
  const startedAt = env.now()
  let nextProgress = START_PROGRESS_MS
  let nextRunningCheck = RUNNING_CHECK_MS
  for (;;) {
    const waitedMs = env.now() - startedAt
    const health = await checkHealth(env, readDaemonInfo(env.dataDir).port)
    if (health.up) return { ok: true, waitedMs: env.now() - startedAt }
    if (waitedMs >= timeoutMs) return { ok: false, reason: 'timeout' }
    if (waitedMs >= nextRunningCheck) {
      nextRunningCheck = waitedMs + RUNNING_CHECK_MS
      if (await serviceStopped(service)) return { ok: false, reason: 'not-running' }
    }
    if (waitedMs >= nextProgress) {
      env.out(`still waiting for the daemon (${Math.floor(waitedMs / 1000)} s): it opens memory.db and reads the spool before it answers`)
      nextProgress += START_PROGRESS_MS
    }
    await env.sleep(HEALTH_POLL_MS)
  }
}

function authorized(env: InstallEnv): { base: string; token: string } {
  const endpoint = readDaemonEndpoint(env.dataDir)
  if (endpoint === null) throw new Error('daemon.json or daemon.token is missing; the daemon is not running')
  return { base: `http://127.0.0.1:${endpoint.port}`, token: endpoint.token }
}

/** Throws with the HTTP status (401, 403, 400 ...) and the daemon's field message, never the body we sent. */
export async function putObserverSettings(env: InstallEnv, input: ObserverSettingsInput): Promise<void> {
  const { base, token } = authorized(env)
  const response = await env.fetch(`${base}/observer/settings`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 200) return
  const body: unknown = await response.json().catch(() => null)
  const detail = isRecord(body) && typeof body.error === 'string' ? `: ${body.error}` : ''
  throw new Error(`PUT /observer/settings for ${input.host} answered ${response.status}${detail}`)
}

export type SettingsRead = { ok: true; view: ObserverSettingsView } | { ok: false; reason: string }

export async function getObserverSettings(env: InstallEnv): Promise<SettingsRead> {
  try {
    const { base, token } = authorized(env)
    const response = await env.fetch(`${base}/observer/settings`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (response.status === 404) return { ok: false, reason: 'the running daemon is an older build without /observer/settings' }
    if (response.status !== 200) return { ok: false, reason: `GET /observer/settings answered ${response.status}` }
    const body: unknown = await response.json()
    if (!isRecord(body) || !Array.isArray(body.rows) || !Array.isArray(body.effective)) return { ok: false, reason: 'unexpected settings body' }
    return { ok: true, view: body as unknown as ObserverSettingsView }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : 'request failed' }
  }
}
