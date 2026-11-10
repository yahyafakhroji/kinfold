// The /read/ routes: memory reads over the daemon's own store, for a client
// that cannot open memory.db itself (a WSL agent reading a Windows install).
// They run the same tool code as the local MCP server and take the
// data-folder token like every other API route; a dashboard cookie is
// refused. There is no write route here, so the spool stays the only way in.
// The log carries the tool, status, row count and time; never the arguments,
// the query or the answer.

import { posix, win32 } from 'node:path'
import type { Parsed } from '../context/types'
import type { MemoryReader } from '../mcp/reader'
import type { SemanticClient } from '../mcp/semantic-client'
import { callTool } from '../mcp/tools'
import type { ProjectKeyResolver } from '../store/project-key'
import type { RouteAnswer } from './data-routes'

export const READ_TOOLS = ['search', 'timeline', 'get_observations'] as const
export type ReadTool = (typeof READ_TOOLS)[number]

/** Longer than any real working directory; the cap keeps a hostile body from reaching git. */
export const MAX_READ_CWD_CHARS = 4_096

const PREFIX = '/read/'
const KEYS = ['args', 'cwd'] as const

export interface ReadRouteDeps {
  /** A read-only reader over the daemon's store, opened on first use; null while there is no database. */
  reader: () => MemoryReader | null
  /** The resolver ingest uses, so a cwd maps to the same project key on both paths. */
  projectKeyFor: ProjectKeyResolver
  now: () => number
  /** Present only when sqlite-vec loaded in the daemon. */
  semantic?: SemanticClient
}

export interface ReadRequest {
  /** The tool's own arguments; the tool validates them exactly as the MCP server does. */
  args: unknown
  /** The caller's working directory; null when the caller has none, so the tool needs an explicit project. */
  cwd: string | null
}

interface ReadAnswer extends RouteAnswer {
  count: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A WSL caller sends a POSIX path and a Windows caller a drive or UNC path; the daemon's own OS does not decide which is valid.
function isAbsoluteCwd(cwd: string): boolean {
  return cwd.length <= MAX_READ_CWD_CHARS && !cwd.includes('\0') && (posix.isAbsolute(cwd) || win32.isAbsolute(cwd))
}

/** Exactly `args` and `cwd`. Errors are fixed strings and never echo the body. */
export function parseReadRequest(body: unknown): Parsed<ReadRequest> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  const keys = Object.keys(body).sort()
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) {
    return { ok: false, error: 'body must have exactly the keys args, cwd' }
  }
  const { args, cwd } = body
  if (cwd !== null && (typeof cwd !== 'string' || !isAbsoluteCwd(cwd))) {
    return { ok: false, error: `cwd must be null or an absolute path of at most ${MAX_READ_CWD_CHARS} characters` }
  }
  return { ok: true, value: { args, cwd } }
}

const isReadTool = (name: string): name is ReadTool => (READ_TOOLS as readonly string[]).includes(name)

async function answerRead(tool: ReadTool, method: string, body: () => Promise<Parsed<unknown>>, deps: ReadRouteDeps): Promise<ReadAnswer> {
  if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' }, count: 0 }
  const raw = await body()
  const parsed = raw.ok ? parseReadRequest(raw.value) : raw
  if (!parsed.ok) return { status: 400, body: { error: parsed.error }, count: 0 }
  const { args, cwd } = parsed.value
  const projectKey = cwd === null ? null : deps.projectKeyFor(cwd).key
  const semantic = deps.semantic !== undefined ? { semantic: deps.semantic } : {}
  const outcome = await callTool(tool, args, { reader: deps.reader, projectKey, now: deps.now, ...semantic })
  // Unreachable while READ_TOOLS names only tools callTool has; a renamed tool then reads as a 404, not a crash.
  if (outcome === null) return { status: 404, body: { error: 'not found' }, count: 0 }
  return { status: 200, body: { outcome }, count: outcome.count }
}

/** The answer for a /read/ path, or null for the server's 404. */
export async function readRoute(
  method: string,
  path: string,
  body: () => Promise<Parsed<unknown>>,
  deps: ReadRouteDeps,
  log: (line: string) => void,
): Promise<RouteAnswer | null> {
  const tool = path.slice(PREFIX.length)
  if (!path.startsWith(PREFIX) || !isReadTool(tool)) return null
  const startedAt = performance.now()
  const answer = await answerRead(tool, method, body, deps)
  log(`read ${tool} status=${answer.status} count=${answer.count} ms=${Math.round(performance.now() - startedAt)}`)
  return { status: answer.status, body: answer.body }
}
