// Where an MCP tool call goes when the MCP server cannot read memory.db in
// place. Null means the local read-only reader answers, as it always has;
// no platform routes calls elsewhere yet.

import type { ToolCaller } from '../mcp/tools'
import type { PlatformInfo } from '../platform/platform'

export interface McpBackendInput {
  dataDir: string
  cwd: string
  platform: PlatformInfo
}

export function mcpToolCallerFor(_input: McpBackendInput): ToolCaller | null {
  return null
}
