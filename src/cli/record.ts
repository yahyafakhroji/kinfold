// The shared tail of every capture path: edge redaction into the spool, then a
// best-effort nudge. The spool write is what matters; a dead or slow daemon
// only delays ingest, because its fallback interval drains the spool anyway.
// The marker key is the daemon's newest per-epoch sub-key file: one
// small read, never a Keychain lookup on the hook path.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEvent } from '../capture/capture'
import type { NormalizedEvent } from '../contract/event'
import { DAEMON_INFO_FILE, SPOOL_DIR, TOKEN_FILE, ensureDataDir } from '../store/data-dir'
import { loadMarkerKey } from '../store/hmac-key'

export const NUDGE_BUDGET_MS = 250

export type NudgeResult = { ok: true } | { ok: false; reason: string }

export interface RecordResult {
  spoolPath: string
  nudge: NudgeResult
}

function daemonPort(dataDir: string): number | null {
  const path = join(dataDir, DAEMON_INFO_FILE)
  if (!existsSync(path)) return null
  const info: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof info !== 'object' || info === null || !('port' in info)) return null
  const port = info.port
  return typeof port === 'number' && Number.isInteger(port) && port > 0 ? port : null
}

function daemonToken(dataDir: string): string | null {
  const path = join(dataDir, TOKEN_FILE)
  if (!existsSync(path)) return null
  const token = readFileSync(path, 'utf8').trim()
  return token === '' ? null : token
}

/** Never throws: every failure comes back as a reason the caller can log. */
export async function nudgeDaemon(dataDir: string, budgetMs: number = NUDGE_BUDGET_MS): Promise<NudgeResult> {
  try {
    const port = daemonPort(dataDir)
    const token = daemonToken(dataDir)
    if (port === null || token === null) return { ok: false, reason: 'daemon not running (no daemon.json or token)' }
    const response = await fetch(`http://127.0.0.1:${port}/spool/nudge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(budgetMs),
    })
    return response.status === 202 ? { ok: true } : { ok: false, reason: `daemon answered ${response.status}` }
  } catch (error: unknown) {
    return { ok: false, reason: `daemon unreachable: ${error instanceof Error ? error.name : 'unknown error'}` }
  }
}

export async function recordEvent(event: NormalizedEvent, dataDir: string): Promise<RecordResult> {
  const spoolDir = join(ensureDataDir(dataDir), SPOOL_DIR)
  const spoolPath = captureEvent(event, { spoolDir, ...loadMarkerKey(dataDir, Date.now()) })
  return { spoolPath, nudge: await nudgeDaemon(dataDir) }
}
