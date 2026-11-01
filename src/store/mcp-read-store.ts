// Store side of MCP read reporting (P1-H). The MCP server is read-only (D3),
// so after each tool call it reports what it returned to the daemon, which
// writes one mcp_reads row here. A row names the tool, the project scope, the
// observation ids returned, counts and timing; never query text or arguments.
// The read queries feed the hit-rate proxies in src/dashboard/hit-rate.ts.

import type { Database } from '../sqlite/types'

export const MCP_TOOLS = ['search', 'timeline', 'get_observations'] as const
export type McpTool = (typeof MCP_TOOLS)[number]

export const MCP_READ_STATUSES = ['ok', 'not_found', 'no_memory', 'usage_error', 'internal_error'] as const
export type McpReadStatus = (typeof MCP_READ_STATUSES)[number]

export interface McpRead {
  tool: McpTool
  /** The scope the tool read: a project key, or '*' for every project. */
  projectKey: string
  /** From KINFOLD_MCP_HOST in the server's environment; null when the entry does not set it. */
  host: string | null
  returnedIds: readonly number[]
  rows: number
  ms: number
  status: McpReadStatus
}

export interface StoredMcpRead extends Omit<McpRead, 'returnedIds'> {
  occurredAt: number
  returnedIds: number[]
}

/** One injection as the hit-rate math needs it: where, when and which ids. */
export interface InjectedIds {
  projectKey: string
  host: string
  channel: string
  occurredAt: number
  observationIds: number[]
}

function parseIds(json: string): number[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)) : []
  } catch {
    // A row this build did not write: count it with no ids rather than fail the summary.
    return []
  }
}

export function insertMcpRead(db: Database, read: McpRead, occurredAt: number): number {
  const row = db.query<{ id: number }, Record<string, string | number | null>>(
    `INSERT INTO mcp_reads (occurred_at, project_key, host, tool, returned_ids, rows, ms, status)
     VALUES ($occurredAt, $projectKey, $host, $tool, $returnedIds, $rows, $ms, $status) RETURNING id`,
  ).get({
    occurredAt, projectKey: read.projectKey, host: read.host, tool: read.tool,
    returnedIds: JSON.stringify(read.returnedIds), rows: read.rows, ms: Math.round(read.ms), status: read.status,
  })
  if (row === null) throw new Error('mcp read insert returned no row')
  return row.id
}

interface RawRead {
  occurredAt: number
  projectKey: string
  host: string | null
  tool: McpTool
  returnedIds: string
  rows: number
  ms: number
  status: McpReadStatus
}

export function mcpReadsSince(db: Database, since: number): StoredMcpRead[] {
  return db.query<RawRead, { since: number }>(
    `SELECT occurred_at AS occurredAt, project_key AS projectKey, host, tool, returned_ids AS returnedIds, rows, ms, status
     FROM mcp_reads WHERE occurred_at >= $since ORDER BY occurred_at, id`,
  ).all({ since }).map((row) => ({ ...row, returnedIds: parseIds(row.returnedIds) }))
}

/** Injections in the window with a known project (rows from before v3 have none). */
export function injectedIdsSince(db: Database, since: number): InjectedIds[] {
  return db.query<Omit<InjectedIds, 'observationIds'> & { observationIds: string }, { since: number }>(
    `SELECT project_key AS projectKey, host, channel, occurred_at AS occurredAt, observation_ids AS observationIds
     FROM injections WHERE occurred_at >= $since AND project_key IS NOT NULL ORDER BY occurred_at, id`,
  ).all({ since }).map((row) => ({ ...row, observationIds: parseIds(row.observationIds) }))
}
