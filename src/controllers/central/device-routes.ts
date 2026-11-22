// How a central device's loopback daemon answers its own API. MCP reads and
// the dashboard's read views come from the hub through the relay; recall does
// too, through the device core's context handler, which adds the device's own
// update notice.
// Anything that changes or removes stored memory is refused here with "run
// this on the hub": the hub does not offer those to devices, and the device's
// local store is kept untouched as its backup. Everything else (update
// settings, dashboard pages and login, health, the spool nudge) stays local.

import type { Parsed } from '../../resources/context/types'
import type { RouteAnswer } from '../daemon/data-routes'
import { parseMcpRead } from '../daemon/mcp-read-route'
import { READ_TOOLS, parseReadRequest } from '../daemon/read-routes'
import { parseSemanticRequest } from '../../resources/vectors/search'
import { VIEW_PATHS } from './hub-routes'
import type { Relay } from './relay'

export const HUB_ONLY_ERROR = 'run this on the hub: this device uses central memory'

export interface DeviceRouting {
  relay: Relay
  hubName: string
  /** This device's own update notice, which `kinfold watch` shows in place of the hub's. */
  watchUpdate?: () => unknown
}

const BACKUP_PATHS = new Set(['/backup', '/restore', '/restore/upload', '/restore/undo', '/restore/status'])
// The observer runs on the hub, so its token is kept there too.
const HUB_ONLY_ANY_METHOD = new Set(['/observer/retry', '/observer/recheck', '/observer/test', '/observer/claude-token'])
const HUB_ONLY_WRITES = new Set(['/observer/settings', '/embedding/settings'])

export function isHubOnly(method: string, path: string): boolean {
  if (BACKUP_PATHS.has(path) || HUB_ONLY_ANY_METHOD.has(path)) return true
  const write = method !== 'GET' && method !== 'HEAD'
  // The display switches are this device's: its hooks read them from its own display file.
  if (path === '/data/display') return false
  return write && (HUB_ONLY_WRITES.has(path) || path.startsWith('/data/') || path.startsWith('/memory/'))
}

const isView = (path: string): boolean => VIEW_PATHS.includes(path) || path.startsWith('/memory/')

async function parsed<T>(body: () => Promise<Parsed<unknown>>, parse: (value: unknown) => Parsed<T>): Promise<Parsed<T>> {
  const raw = await body()
  return raw.ok ? parse(raw.value) : raw
}

const bad = (error: string): RouteAnswer => ({ status: 400, body: { error } })

/** The device's answer for this request, or null when the local daemon answers it as before. */
export async function deviceRoute(method: string, url: URL, body: () => Promise<Parsed<unknown>>, routing: DeviceRouting): Promise<RouteAnswer | null> {
  const path = url.pathname
  const { relay } = routing
  if (isHubOnly(method, path)) return { status: 409, body: { error: HUB_ONLY_ERROR, hubOnly: true, hub: routing.hubName } }
  if (method === 'GET' && path === '/watch') {
    const answer = await relay.view(`${path}${url.search}`)
    const watched = answer.body
    if (answer.status !== 200 || typeof watched !== 'object' || watched === null) return answer
    // The notice is about the program that runs here; the hub's is about the hub's.
    return { status: 200, body: { ...watched, update: routing.watchUpdate?.() ?? null } }
  }
  if (method === 'GET' && isView(path)) return relay.view(`${path}${url.search}`)
  if (method !== 'POST') return null
  if (path.startsWith('/read/')) {
    const tool = path.slice('/read/'.length)
    if (!(READ_TOOLS as readonly string[]).includes(tool)) return null
    const request = await parsed(body, parseReadRequest)
    return request.ok ? relay.read(tool, request.value.args, request.value.cwd) : bad(request.error)
  }
  if (path === '/search/semantic') {
    const request = await parsed(body, parseSemanticRequest)
    return request.ok ? { status: 200, body: await relay.semantic(request.value) } : bad(request.error)
  }
  if (path === '/metrics/mcp-read') {
    const read = await parsed(body, parseMcpRead)
    return read.ok ? relay.mcpRead(read.value) : bad(read.error)
  }
  return null
}
