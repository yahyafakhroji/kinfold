// The shared tail of every capture path: edge redaction into the spool, then a
// best-effort nudge. The spool write is what matters; a dead or slow daemon
// only delays ingest, because its fallback interval drains the spool anyway.
// The marker key is the daemon's newest per-epoch sub-key file: one
// small read, never a Keychain lookup on the hook path.

import { join } from 'node:path'
import { captureEvent } from '../capture/capture'
import type { NormalizedEvent } from '../contract/event'
import { readDaemonEndpoint } from '../daemon/daemon-info'
import { SPOOL_DIR, ensureDataDir } from '../store/data-dir'
import { loadMarkerKey } from '../store/hmac-key'

export const NUDGE_BUDGET_MS = 250

export type NudgeResult = { ok: true } | { ok: false; reason: string }

export interface RecordResult {
  spoolPath: string
  nudge: NudgeResult
}

/** Never throws: every failure comes back as a reason the caller can log. */
export async function nudgeDaemon(dataDir: string, budgetMs: number = NUDGE_BUDGET_MS): Promise<NudgeResult> {
  try {
    // Null too for files a crashed daemon left: the token goes to no process that has since taken the port.
    const endpoint = readDaemonEndpoint(dataDir)
    if (endpoint === null) return { ok: false, reason: 'daemon not running (no daemon.json or token)' }
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/spool/nudge`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(budgetMs),
      redirect: 'error',
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
