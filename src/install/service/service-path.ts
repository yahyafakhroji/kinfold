// The PATH the Windows daemon needs to find the agent CLIs. A scheduled task
// starts the daemon at logon with the registry PATH, which misses a CLI that
// only the installer's shell could find (fnm, volta, nvm-windows, a dev
// shell), and Task Scheduler XML cannot carry environment variables. So
// install records the folders of the CLIs it found, and the daemon puts them
// in front of its own PATH at start. macOS and Linux carry the same folders in
// the plist and the unit instead.

import { readFileSync, realpathSync } from 'node:fs'
import { join, win32 } from 'node:path'
import { writeFileAtomic } from '../../fs/atomic'
import type { OsName } from '../../platform/platform'
import { DAEMON_TOOLS, type Which, bunWhich } from '../launch-agent'

export const SERVICE_PATH_FILE = 'service-path.json'
const FILE_MODE = 0o600

/**
 * The program's folder, then the folder of each daemon tool the installer's
 * PATH finds, in tool order, once each. A tool found as an npm `.cmd` shim
 * runs on node, so node's folder follows it. Each folder is recorded by its
 * real location: fnm puts node and its global bins on a per-shell junction
 * that it deletes later, so the found path would not exist at the next logon.
 */
export function servicePathFor(
  env: { bunPath: string; pathEnv: string },
  which: Which = bunWhich,
  realpath: (path: string) => string = realpathSync,
): string {
  const folderOf = (path: string): string => {
    try {
      return win32.dirname(realpath(path))
    } catch {
      return win32.dirname(path)
    }
  }
  const folders = [win32.dirname(env.bunPath)]
  for (const tool of DAEMON_TOOLS) {
    const found = which(tool, env.pathEnv)
    if (found === null) continue
    folders.push(folderOf(found))
    if (/\.(cmd|bat)$/i.test(found)) {
      const node = which('node', env.pathEnv)
      if (node !== null) folders.push(folderOf(node))
    }
  }
  return [...new Set(folders.filter((folder) => folder !== '' && win32.isAbsolute(folder)))].join(';')
}

/** The file's text, as install writes it and compares it. */
export function servicePathContent(path: string): string {
  return `${JSON.stringify({ path })}\n`
}

export function writeServicePath(dataDir: string, path: string): void {
  writeFileAtomic(join(dataDir, SERVICE_PATH_FILE), servicePathContent(path), FILE_MODE)
}

export function readServicePath(dataDir: string): string | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, SERVICE_PATH_FILE), 'utf8'))
    const path = typeof value === 'object' && value !== null ? (value as { path?: unknown }).path : undefined
    return typeof path === 'string' && path !== '' ? path : null
  } catch {
    return null
  }
}

/** On Windows, puts the recorded folders in front of the process PATH, under whichever spelling of the key it already has. */
export function applyServicePath(dataDir: string, env: Record<string, string | undefined>, os: OsName): void {
  if (os !== 'windows') return
  const recorded = readServicePath(dataDir)
  if (recorded === null) return
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const current = env[key]
  env[key] = current === undefined || current === '' ? recorded : `${recorded};${current}`
}
