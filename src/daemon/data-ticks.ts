// Background data control, off the hot path: one small scanner batch per scan
// tick while anything is left under an old rules version, and a retention
// pass per retention tick. Neither runs at start (the drain and the observer
// go first); both log counts and rule names only, and a failure is logged and
// retried on the next tick. The marker key is read per tick, so a rotation
// takes effect without a restart.

import { applyRetention, describeRetention } from '../data-control/retention'
import { DEFAULT_SCAN_BATCH, describeScan, scanBatch } from '../data-control/scanner'
import type { MarkerKey } from '../redaction/redact'
import type { Database } from '../sqlite/types'

export const DEFAULT_SCAN_TICK_MS = 10_000
export const DEFAULT_RETENTION_TICK_MS = 10 * 60_000

export interface DataTickOptions {
  db: Database
  markerKey: () => MarkerKey
  log: (line: string) => void
  now?: () => number
  scanTickMs?: number
  retentionTickMs?: number
  scanBatchSize?: number
}

export interface DataTicks {
  /** One scan batch now; returns whether rows were left. */
  scanTick: () => boolean
  retentionTick: () => void
  stop: () => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function startDataTicks(options: DataTickOptions): DataTicks {
  const now = options.now ?? Date.now
  const { db, log } = options
  let idle = false

  const scanTick = (): boolean => {
    try {
      const result = scanBatch(db, { ...options.markerKey(), now, batchSize: options.scanBatchSize ?? DEFAULT_SCAN_BATCH })
      // Log work, and the first idle tick after it; a fully scanned store stays quiet.
      if (result.scanned > 0 || !idle) log(describeScan(result))
      idle = result.scanned === 0
      return result.remaining > 0
    } catch (error: unknown) {
      log(`data scan failed: ${errorMessage(error)}`)
      return false
    }
  }
  const retentionTick = (): void => {
    try {
      const line = describeRetention(applyRetention(db, now()))
      if (line !== null) log(line)
    } catch (error: unknown) {
      log(`data retention failed: ${errorMessage(error)}`)
    }
  }
  const timers = [
    setInterval(scanTick, options.scanTickMs ?? DEFAULT_SCAN_TICK_MS),
    setInterval(retentionTick, options.retentionTickMs ?? DEFAULT_RETENTION_TICK_MS),
  ]
  return { scanTick, retentionTick, stop: () => timers.forEach(clearInterval) }
}
