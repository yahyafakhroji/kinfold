// How the installed program's own files are put in place and taken away. On
// macOS and Linux a running program can be renamed over and its folder
// deleted; Windows locks a running .exe, so its version has to step around
// that and may have to leave a file behind until the program exits.

import { renameSync, rmSync } from 'node:fs'
import type { PlatformInfo } from '../platform/platform'
import { type InstallEnv, platformOf } from './env'
import { windowsProgramFiles } from './program-files-windows'

export interface ProgramFiles {
  /** Puts the verified temp file at target. POSIX: renameSync. */
  replace(temp: string, target: string): void
  /** Removes the bin folder; returns the paths it had to leave behind. POSIX: a recursive remove, []. */
  removeBinDir(dir: string): string[]
}

export const posixProgramFiles: ProgramFiles = {
  replace: (temp, target) => renameSync(temp, target),
  removeBinDir: (dir) => {
    rmSync(dir, { force: true, recursive: true })
    return []
  },
}

export function programFilesFor(platform: PlatformInfo): ProgramFiles {
  return platform.os === 'windows' ? windowsProgramFiles : posixProgramFiles
}

/** The env's own program files when a test injects them, else this platform's. */
export function programFilesOf(env: InstallEnv): ProgramFiles {
  return env.programFiles ?? programFilesFor(platformOf(env))
}

export function leftBehindLine(path: string): string {
  return `uninstall: could not remove ${path}; a running kinfold (an agent session's MCP server) still uses it. Remove it after closing those sessions`
}
