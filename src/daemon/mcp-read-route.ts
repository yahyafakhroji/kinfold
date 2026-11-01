// POST /metrics/mcp-read: the MCP server's after-the-fact report of one tool
// call (P1-H). The MCP server never writes the database (D3); it posts here
// and the daemon writes one mcp_reads row. The body is checked strictly: an
// exact key set, so a body that carries query text or any other field is
// refused, ids are positive integers (at most 100), and the tool and status
// come from fixed lists. Token only (src/dashboard/access.ts: not a
// dashboard route). Errors name the field and never echo a value.

import type { Parsed } from '../context/types'
import type { Database } from '../sqlite/types'
import { MCP_READ_STATUSES, MCP_TOOLS, type McpRead, type McpReadStatus, type McpTool, insertMcpRead } from '../store/mcp-read-store'

export const MAX_REPORTED_IDS = 100
const MAX_ROWS = 1_000
const MAX_MS = 600_000
const MAX_PROJECT_KEY_CHARS = 4_096
const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KEYS = ['host', 'ms', 'projectKey', 'returnedIds', 'rows', 'status', 'tool'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isCount = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max

function idsOf(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > MAX_REPORTED_IDS) return null
  return value.every((id) => Number.isSafeInteger(id) && id > 0) ? (value as number[]) : null
}

/** Exactly the report's keys; host may be null (an entry without KINFOLD_MCP_HOST). */
export function parseMcpRead(body: unknown): Parsed<McpRead> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  const keys = Object.keys(body).sort()
  if (keys.length !== KEYS.length || keys.some((key, index) => key !== KEYS[index])) {
    return { ok: false, error: `body must have exactly the keys ${KEYS.join(', ')}` }
  }
  const { tool, projectKey, host, returnedIds, rows, ms, status } = body
  if (!MCP_TOOLS.includes(tool as McpTool)) return { ok: false, error: 'tool must be search, timeline or get_observations' }
  if (typeof projectKey !== 'string' || projectKey === '' || projectKey.length > MAX_PROJECT_KEY_CHARS) return { ok: false, error: 'projectKey must be a non-empty string' }
  if (host !== null && (typeof host !== 'string' || !HOST_PATTERN.test(host))) return { ok: false, error: 'host must be null or a short lowercase name' }
  const ids = idsOf(returnedIds)
  if (ids === null) return { ok: false, error: `returnedIds must be at most ${MAX_REPORTED_IDS} positive integers` }
  if (!isCount(rows, MAX_ROWS)) return { ok: false, error: 'rows must be a whole number from 0 to 1000' }
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_MS) return { ok: false, error: 'ms must be a number from 0 to 600000' }
  if (!MCP_READ_STATUSES.includes(status as McpReadStatus)) return { ok: false, error: 'status is not a known tool status' }
  return { ok: true, value: { tool: tool as McpTool, projectKey, host, returnedIds: ids, rows, ms, status: status as McpReadStatus } }
}

/** Writes the row; the log line carries the tool, status and counts only (a project key is a path). */
export function mcpReadHandler(db: Database, log: (line: string) => void, now: () => number = Date.now): (read: McpRead) => number {
  return (read) => {
    const id = insertMcpRead(db, read, now())
    log(`mcp read tool=${read.tool} host=${read.host ?? 'unknown'} status=${read.status} rows=${read.rows} ids=${read.returnedIds.length} ms=${Math.round(read.ms)}`)
    return id
  }
}
