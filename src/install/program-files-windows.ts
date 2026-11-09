// The Windows program files. Until the Windows port lands this behaves like
// the POSIX one, so nothing on Windows changes yet.

import { renameSync, rmSync } from 'node:fs'
import type { ProgramFiles } from './program-files'

export const windowsProgramFiles: ProgramFiles = {
  replace: (temp, target) => renameSync(temp, target),
  removeBinDir: (dir) => {
    rmSync(dir, { force: true, recursive: true })
    return []
  },
}
