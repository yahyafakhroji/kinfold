// Where a running daemon listens and the token it wants, read from the data
// dir (daemon.json and daemon.token). Clients use this to reach the read API;
// a missing or malformed file means "no daemon", never an exception.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DAEMON_INFO_FILE, TOKEN_FILE } from '../store/data-dir'

export interface DaemonEndpoint {
  port: number
  token: string
}

function readPort(dataDir: string): number | null {
  const path = join(dataDir, DAEMON_INFO_FILE)
  if (!existsSync(path)) return null
  const info: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof info !== 'object' || info === null || !('port' in info)) return null
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
