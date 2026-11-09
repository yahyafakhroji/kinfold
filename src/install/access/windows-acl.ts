// The data dir check on Windows. A stub until the access list read is written:
// Unix modes mean nothing there, so it plans no chmod and claims nothing.

import { existsSync } from 'node:fs'
import type { InstallEnv } from '../env'
import type { DataDirAccess } from './check'

export function windowsAclAccess(_env: InstallEnv): DataDirAccess {
  return {
    plannedFixes: () => ({ changes: [], symlinks: [] }),
    statusLines: async (dataDir) => [existsSync(dataDir) ? `data dir ${dataDir}: access list not checked yet` : `data dir ${dataDir}: missing`],
  }
}
