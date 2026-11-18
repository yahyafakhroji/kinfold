// The central-memory lines of `kinfold status`: whether this machine's memory
// is its own, the hub's for its devices, or a hub's it uses; and for a
// device, whether the hub answers and how many captures wait for it.

import { readDaemonEndpoint } from '../daemon/daemon-info'
import type { CentralStatus } from './daemon-central'
import { centralModeOf } from './mode'

export interface StatusEnv {
  dataDir: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}

const STATUS_TIMEOUT_MS = 6_000
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

async function askDaemon(env: StatusEnv): Promise<CentralStatus | null> {
  const endpoint = readDaemonEndpoint(env.dataDir)
  if (endpoint === null) return null
  try {
    const response = await env.fetch(`http://127.0.0.1:${endpoint.port}/central/status?check=1`, { headers: { authorization: `Bearer ${endpoint.token}` }, signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) })
    return response.status === 200 ? ((await response.json()) as CentralStatus) : null
  } catch {
    return null
  }
}

const REFUSALS: ReadonlySet<string> = new Set(['refused', 'unpaired', 'version', 'bad-signature', 'too-large'])

/** The device's link to its hub in a few words: a late answer is a busy hub, which is not the same as no route to it, nor a refusal. */
export function reachText(live: { reachable: boolean | null; failure?: string | null; problem: string | null }): string {
  const failure = live.failure ?? null
  if (failure === 'timeout') return `busy: ${live.problem ?? 'the hub did not answer in time'}; it is asked again`
  if (failure !== null && REFUSALS.has(failure)) return `refused: ${live.problem ?? failure}`
  if (failure === 'hub-error' || failure === 'bad-answer') return `error: ${live.problem ?? failure}`
  if (live.reachable === true && live.problem === null) return 'reachable'
  return `not reachable: ${live.problem ?? 'not asked yet'}`
}

export async function centralStatusLines(env: StatusEnv): Promise<string[]> {
  const mode = centralModeOf(env.dataDir)
  if (mode === null) return ['memory: local (this machine\'s own)']
  const live = await askDaemon(env)
  if (mode.role === 'hub') {
    if (live?.role !== 'hub') return ['memory: hub (the daemon is not running, so devices cannot reach it)']
    const devices = plural(live.devices.length, 'paired device')
    return [live.listening !== null ? `memory: hub for ${devices}, listening on ${live.listening} (Tailscale only)` : `memory: hub for ${devices}, not listening: ${live.error ?? 'starting'}`]
  }
  const where = `${mode.hubName} (${mode.hub.includes(':') ? `[${mode.hub}]` : mode.hub}:${mode.port})`
  const observer = `observer: runs on ${mode.hubName}, with the hub's settings for each agent`
  if (live?.role !== 'device') return [`memory: central, on ${where}; this device's daemon is not running, so nothing is sent or recalled`, observer]
  const reach = reachText(live)
  const queue = live.queued === 0 ? [] : [`central queue: ${plural(live.queued, 'capture')} waiting for ${mode.hubName}; it is sent when the hub is back`]
  return [`memory: central, on ${where}; ${reach}`, ...queue, observer]
}
