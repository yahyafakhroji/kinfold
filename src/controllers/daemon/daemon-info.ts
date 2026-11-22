// Where a running daemon listens and the token it wants, read from the data
// dir (daemon.json and daemon.token). Clients use this to reach the read API;
// a missing or malformed file means "no daemon", never an exception. So do
// files a daemon left behind when it crashed: daemon.json names its pid, and
// when no such process exists nothing is read as running. Otherwise every
// client would send the token (and a hook the user's prompt) to whatever
// process had since taken the port. A WSL distro is the exception: the
// daemon.json it reads may be the Windows daemon's, whose pid means nothing
// in the distro, so there the pid is not asked about.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { currentPlatform } from '../platform/platform'
import { DAEMON_INFO_FILE, TOKEN_FILE } from '../store/data-dir'

export interface DaemonEndpoint {
  port: number
  token: string
}

/**
 * False only when the system says no process has this pid. A pid we may not
 * signal (another user's, or one above our rights) still counts as running:
 * refusing to talk to a live daemon would be worse than the rare reused pid.
 */
function isRunning(pid: number): boolean {
  if (currentPlatform().wsl) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
}

function readPort(dataDir: string): number | null {
  const path = join(dataDir, DAEMON_INFO_FILE)
  if (!existsSync(path)) return null
  const info: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof info !== 'object' || info === null || !('port' in info)) return null
  // A daemon.json from before pids were written has none, and is read as it always was.
  const pid = 'pid' in info ? info.pid : undefined
  if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && !isRunning(pid)) return null
  const port = info.port
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null
}

function readToken(dataDir: string): string | null {
  const path = join(dataDir, TOKEN_FILE)
  if (!existsSync(path)) return null
  const token = readFileSync(path, 'utf8').trim()
  return token === '' ? null : token
}

export function readDaemonEndpoint(dataDir: string): DaemonEndpoint | null {
  try {
    const port = readPort(dataDir)
    const token = readToken(dataDir)
    return port === null || token === null ? null : { port, token }
  } catch (error: unknown) {
    // A half-written or unreadable daemon.json is the same as no daemon.
    if (error instanceof Error) return null
    throw error
  }
}
