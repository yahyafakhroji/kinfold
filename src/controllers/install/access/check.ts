// Who can read the data dir, asked through one check per platform: modes on
// macOS and Linux, the access list on Windows. install applies the fixes a check
// plans; status prints its lines.

import { type InstallEnv, platformOf } from '../env'
import type { ModeChange } from '../permissions'
import { posixModeAccess } from './posix-modes'
import { windowsAclAccess } from './windows-acl'

export interface DataDirAccess {
  /** install: chmod fixes and the symlinks left alone. Windows: none, since install does not change ACLs. */
  plannedFixes(dataDir: string): { changes: ModeChange[]; symlinks: string[] }
  /** kinfold status: the folder's lines. Async, since an ACL read spawns a tool. */
  statusLines(dataDir: string): Promise<string[]>
}

/** The injected env.dataDirAccess, else the platform's. */
export function dataDirAccessFor(env: InstallEnv): DataDirAccess {
  if (env.dataDirAccess !== undefined) return env.dataDirAccess
  switch (platformOf(env).os) {
    case 'macos':
    case 'linux':
      return posixModeAccess(env)
    case 'windows':
      return windowsAclAccess(env)
  }
}
