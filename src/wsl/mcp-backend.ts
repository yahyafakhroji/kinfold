// Where an MCP tool call goes when the MCP server cannot read memory.db in
// place. A WSL server whose data folder is on a Windows drive asks the Windows
// daemon over loopback, because SQLite locking does not hold across the
// /mnt/<drive> mount. Null means the local read-only reader answers, as it
// always has: every other platform, and a WSL install with its own Linux data
// folder.

import type { ToolCaller } from '../mcp/tools'
import type { PlatformInfo } from '../platform/platform'
import { daemonToolCaller } from './daemon-tools'

export interface McpBackendInput {
  dataDir: string
  cwd: string
  platform: PlatformInfo
}

const WINDOWS_DRIVE = /^\/mnt\/[a-z]\//

/** True for a WSL path into a Windows drive, such as /mnt/c/Users/me/.kinfold. */
export function isOnWindowsDrive(path: string): boolean {
  return WINDOWS_DRIVE.test(path)
}

export function mcpToolCallerFor(input: McpBackendInput): ToolCaller | null {
  if (!input.platform.wsl || !isOnWindowsDrive(input.dataDir)) return null
  return daemonToolCaller({ dataDir: input.dataDir, cwd: input.cwd })
}
