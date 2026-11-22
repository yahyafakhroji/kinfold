// Where an MCP tool call goes when the MCP server cannot read memory.db in
// place. A WSL server whose data folder is on a Windows drive asks the Windows
// daemon over loopback, because SQLite locking does not hold across the
// /mnt/<drive> mount. A central device asks its own daemon, whose relay asks
// the hub, since the memory is there. Null means the local read-only reader
// answers, as it always has.

import type { ToolCaller } from '../mcp/tools'
import type { PlatformInfo } from '../platform/platform'
import { centralModeOf } from '../central/mode'
import { centralToolCaller } from '../central/mcp-caller'
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
  // A WSL distro on a Windows data folder keeps its guarded reader even when Windows is a central device:
  // it reaches the same /read/ routes, which that daemon relays to the hub.
  if (input.platform.wsl && isOnWindowsDrive(input.dataDir)) return daemonToolCaller({ dataDir: input.dataDir, cwd: input.cwd })
  if (centralModeOf(input.dataDir)?.role === 'device') return centralToolCaller({ dataDir: input.dataDir, cwd: input.cwd })
  return null
}
