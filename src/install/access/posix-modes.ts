// The data dir check on macOS and Linux: the mode rules in permissions.ts.

import { existsSync } from 'node:fs'
import type { InstallEnv } from '../env'
import { describeModeChange, scanDataDirModes } from '../permissions'
import type { DataDirAccess } from './check'

export function posixModeAccess(_env: InstallEnv): DataDirAccess {
  return {
    plannedFixes(dataDir) {
      const { changes, symlinks } = scanDataDirModes(dataDir)
      return { changes, symlinks }
    },
    async statusLines(dataDir) {
      if (!existsSync(dataDir)) return [`data dir ${dataDir}: missing`]
      const scan = scanDataDirModes(dataDir)
      if (scan.changes.length === 0) return [`data dir ${dataDir}: modes ok (${scan.checked} checked, dirs 0700, files 0600, program 0755)`]
      return [`data dir ${dataDir}: ${scan.changes.length} of ${scan.checked} need fixing (install fixes them):`, ...scan.changes.map((change) => `  ${describeModeChange(change)}`)]
    },
  }
}
