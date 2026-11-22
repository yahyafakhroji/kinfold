// What a paired device may ask the hub: who it is, store captures, import a
// project from its local memory (adding only what the hub lacks), recall for
// a prompt or a session, MCP reads, semantic search, and the dashboard's read
// views. This list is the whole permission model for devices: read and
// capture. Purge, forget, retention, backup, restore, encryption, keys and
// observer settings are not here, so they can only be done on the hub.

import { type ContextRequest, type ContextResult, parseContextRequest } from '../../resources/context/types'
import { parseMcpRead } from '../daemon/mcp-read-route'
import { READ_TOOLS, type ReadTool } from '../daemon/read-routes'
import type { ToolOutcome } from '../mcp/tools'
import type { McpRead } from '../../resources/store/mcp-read-store'
import type { ProjectKey } from '../../resources/store/project-key'
import { type SemanticAnswer, type SemanticRequest, parseSemanticRequest } from '../../resources/vectors/search'
import { MAX_BATCH_BYTES, type HubAnswer, type HubContext, type HubRoute } from './hub-server'
import { parseDeviceProject } from './project-key'
import { isRecord } from '../../system/contract/event'

/** What the hub's current store answers with; rebuilt when a restore replaces the store. */
export interface CentralCore {
  capture: (body: unknown, context: HubContext) => HubAnswer
  /** Recall for a device's request, under the project the device resolved; no update notice, which is the device's own. */
  context: (request: ContextRequest, project: ProjectKey, budgetMs?: number) => Promise<ContextResult>
  read: (tool: ReadTool, args: unknown, projectKey: string | null) => Promise<ToolOutcome | null>
  semantic: (request: SemanticRequest) => Promise<SemanticAnswer>
  mcpRead: (read: McpRead) => number
  /** Stores what the hub lacks of one chunk of a device's local project. */
  importChunk: (body: unknown, context: HubContext) => HubAnswer
  knownProjects: (keys: readonly string[]) => string[]
}

export interface HubRouteDeps {
  core: () => CentralCore
  /** Answers a GET on the hub's own loopback routes; only VIEW_PATHS reach it. */
  view: (path: string) => Promise<HubAnswer>
  version: string
  hubName: string
}

/** The dashboard and `kinfold watch` reads a device may make; all GET. */
export const VIEW_PATHS: readonly string[] = ['/metrics/summary', '/watch', '/observer/settings', '/sessions', '/data/size', '/data/retention', '/data/findings']
const VIEW_PREFIXES: readonly string[] = ['/memory/']
const MAX_PROJECT_KEY_CHARS = 4_200
const MAX_KNOWN_KEYS = 1_000
/** Far above any wait a hook or plugin has. */
const MAX_BUDGET_MS = 10_000

const bad = (error: string): HubAnswer => ({ status: 400, body: { error } })
const NOT_FOUND: HubAnswer = { status: 404, body: { error: 'not found' } }

/** The path as the hub's server would route it, or null when it is not a listed view. */
export function viewPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.length > 2_048) return null
  let url: URL
  try {
    url = new URL(value, 'http://hub.invalid')
  } catch {
    return null
  }
  if (url.host !== 'hub.invalid') return null
  // Compared after the URL parser resolved any dot segments, so /memory/../data/purge is /data/purge here.
  const path = url.pathname
  const listed = VIEW_PATHS.includes(path) || VIEW_PREFIXES.some((prefix) => path.startsWith(prefix))
  return listed && !value.includes('..') ? `${path}${url.search}` : null
}

async function contextRoute(core: CentralCore, body: unknown, context: HubContext): Promise<HubAnswer> {
  if (!isRecord(body)) return bad('body must be {"request": ..., "project": ...}')
  const request = parseContextRequest(body.request)
  if (!request.ok) return bad(request.error)
  const project = parseDeviceProject(body.project, context.deviceId)
  if (project === null) return bad('project must be a shared remote key or one scoped to this device')
  const budget = body.budgetMs
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0 || budget > MAX_BUDGET_MS)) return bad('budgetMs must be a number of milliseconds')
  return { status: 200, body: await core.context(request.value, project, budget) }
}

async function readRoute(core: CentralCore, body: unknown): Promise<HubAnswer> {
  if (!isRecord(body)) return bad('body must be {"tool": ..., "args": ..., "projectKey": ...}')
  const { tool, args, projectKey } = body
  if (typeof tool !== 'string' || !(READ_TOOLS as readonly string[]).includes(tool)) return NOT_FOUND
  if (projectKey !== null && (typeof projectKey !== 'string' || projectKey === '' || projectKey.length > MAX_PROJECT_KEY_CHARS)) return bad('projectKey must be null or a project key')
  const outcome = await core.read(tool as ReadTool, args, projectKey)
  return outcome === null ? NOT_FOUND : { status: 200, body: { outcome } }
}

export function hubRoutes(deps: HubRouteDeps): Record<string, HubRoute> {
  return {
    '/central/hello': { handle: (_body, context) => ({ status: 200, body: { hubName: deps.hubName, version: deps.version, deviceId: context.deviceId } }) },
    '/central/capture': { cap: MAX_BATCH_BYTES, handle: (body, context) => deps.core().capture(body, context) },
    '/central/context': { handle: (body, context) => contextRoute(deps.core(), body, context) },
    '/central/read': { handle: (body) => readRoute(deps.core(), body) },
    '/central/semantic': {
      handle: async (body) => {
        const parsed = parseSemanticRequest(body)
        return parsed.ok ? { status: 200, body: await deps.core().semantic(parsed.value) } : bad(parsed.error)
      },
    },
    '/central/mcp-read': {
      handle: (body) => {
        const parsed = parseMcpRead(body)
        return parsed.ok ? { status: 201, body: { id: deps.core().mcpRead(parsed.value) } } : bad(parsed.error)
      },
    },
    '/central/import': { cap: MAX_BATCH_BYTES, handle: (body, context) => deps.core().importChunk(body, context) },
    '/central/import/known': {
      handle: (body) => {
        const keys = isRecord(body) ? body.keys : undefined
        if (!Array.isArray(keys) || keys.length > MAX_KNOWN_KEYS || !keys.every((key) => typeof key === 'string' && key.length <= MAX_PROJECT_KEY_CHARS)) return bad('body must be {"keys": [<project key>, ...]}')
        return { status: 200, body: { known: deps.core().knownProjects(keys) } }
      },
    },
    '/central/view': {
      handle: async (body) => {
        const path = isRecord(body) ? viewPath(body.path) : null
        return path === null ? NOT_FOUND : deps.view(path)
      },
    },
  }
}
