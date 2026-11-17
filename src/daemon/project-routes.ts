// The /projects routes, behind the token like every route: `kinfold project
// list|merge|split` read and change which key a repo's memory lives under
// (store/project-merge.ts). Merge and split are dry runs unless the body says
// dryRun: false. On a central device they are refused: the hub holds the
// memory and decides. Logs carry the reason and counts; never a key or name.

import type { Database } from '../sqlite/types'
import { type MaintenanceAnswer, listProjects, mergeProjects, recentMerges, splitProject } from '../store/project-merge'
import type { RouteAnswer } from './data-routes'

/** Merges this recent are said in status and watch. */
export const RECENT_MERGE_MS = 24 * 60 * 60_000
export const DEVICE_REFUSAL = 'this device uses central memory: run kinfold project on the hub'

export interface ProjectRouteDeps {
  db: Database
  now: () => number
  log: (line: string) => void
  /** A central device: every command goes to the hub. */
  device: boolean
}

const MAX_KEY_CHARS = 4_200

function key(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= MAX_KEY_CHARS ? value : null
}

function parseBody(value: unknown, fields: readonly string[]): { keys: string[]; dryRun: boolean } | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const keys = fields.map((field) => key(record[field]))
  if (keys.some((entry) => entry === null)) return null
  if (record.dryRun !== undefined && typeof record.dryRun !== 'boolean') return null
  return { keys: keys as string[], dryRun: record.dryRun !== false }
}

function answered(answer: MaintenanceAnswer, reason: string, log: ProjectRouteDeps['log']): RouteAnswer {
  if (!answer.ok) return { status: 409, body: answer }
  if (!answer.dryRun) log(`project ${reason} ${Object.entries(answer.counts).map(([table, n]) => `${table}=${n}`).join(' ')}`.trim())
  return { status: 200, body: answer }
}

/** Null when the path is not a /projects route. */
export async function projectRoute(method: string, url: URL, readBody: () => Promise<unknown>, deps: ProjectRouteDeps): Promise<RouteAnswer | null> {
  const path = url.pathname
  if (path !== '/projects' && path !== '/projects/merge' && path !== '/projects/split') return null
  if (deps.device) return { status: 409, body: { error: DEVICE_REFUSAL } }
  if (path === '/projects') {
    if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
    return { status: 200, body: { projects: listProjects(deps.db), merges: recentMerges(deps.db, deps.now() - RECENT_MERGE_MS) } }
  }
  if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }
  const merging = path === '/projects/merge'
  const parsed = parseBody(await readBody(), merging ? ['from', 'into'] : ['key'])
  if (parsed === null) {
    return { status: 400, body: { error: merging ? 'body must be {"from": key, "into": key, "dryRun"?: boolean}' : 'body must be {"key": key, "dryRun"?: boolean}' } }
  }
  const options = { dryRun: parsed.dryRun }
  return merging
    ? answered(mergeProjects(deps.db, parsed.keys[0]!, parsed.keys[1]!, deps.now(), options), 'merge reason=manual', deps.log)
    : answered(splitProject(deps.db, parsed.keys[0]!, deps.now(), options), 'split', deps.log)
}
