// The CLI's --data-dir handling, outside the entry module: the entry ends in a
// top-level await, and a compiled program that imports it back from another
// module spins forever, so install and the entry both import this instead.

import { join } from 'node:path'
import type { InstallMode } from '../install/entry'
import type { InstallEnv } from '../install/env'
import { osOf } from '../platform/platform'

/**
 * The same environment aimed at another data folder. An installed program
 * lives in the folder it serves (<dataDir>/bin), so its path follows the
 * folder; a checkout run keeps pointing at the checkout. The path is spelled
 * as installedProgramPath does (entry.ts), repeated because the hook path must
 * not load the installer.
 */
export function envForDataDir(env: InstallEnv, dataDir: string): InstallEnv {
  const mode: InstallMode = env.mode.kind === 'program' ? { kind: 'program', binPath: join(dataDir, 'bin', osOf(env.platform) === 'windows' ? 'kinfold.exe' : 'kinfold') } : env.mode
  return { ...env, dataDir, mode, unflaggedDataDir: env.unflaggedDataDir ?? env.dataDir }
}
