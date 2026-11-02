// The leak scanner. Rows checked under an older rules version (or never, for
// observer output) are re-checked with the current rules, without rewriting
// them: each hit becomes a pending redaction_findings row (table, row id,
// field, rule, version, count), and the row is marked scanned under the
// current version so the next run skips it. Work is cut into small batches,
// one transaction each, so a daemon tick never blocks ingest for long.
// Results and logs carry counts and rule names only. Stored markers of either
// ref form (untagged epoch 0, or e<epoch>.) are never hits: the rules do not
// match a marker, so a row redacted twice is not redacted again.

import { RULES_VERSION } from '../redaction/rules'
import type { Database } from '../sqlite/types'
import { insertFinding } from '../store/findings-store'
import { SCAN_TABLES, type ScanRow, countUnscanned, markScanned, unscannedRows } from '../store/scan-store'
import { findingsOf, redactRow } from './detect'

export const DEFAULT_SCAN_BATCH = 100

export interface ScanOptions {
  hmacKey: string
  /** The marker key's epoch; 0 when left out. */
  epoch?: number
  now: () => number
  batchSize?: number
  /** The rules version to scan under; RULES_VERSION outside tests. */
  version?: number
}

export interface ScanResult {
  scanned: number
  findings: number
  byRule: Record<string, number>
  remaining: number
  ms: number
}

function scanRows(db: Database, rows: readonly ScanRow[], options: ScanOptions, version: number): Record<string, number> {
  const byRule: Record<string, number> = {}
  const foundAt = options.now()
  for (const row of rows) {
    for (const spot of findingsOf(redactRow(row, { hmacKey: options.hmacKey, epoch: options.epoch ?? 0 }).notes)) {
      const added = insertFinding(db, { table: row.table, rowId: row.rowId, field: spot.field, rule: spot.rule, ruleVersion: version, matches: spot.matches, foundAt })
      if (added) byRule[spot.rule] = (byRule[spot.rule] ?? 0) + 1
    }
  }
  return byRule
}

function addCounts(into: Readonly<Record<string, number>>, more: Readonly<Record<string, number>>): Record<string, number> {
  const out = { ...into }
  for (const [rule, n] of Object.entries(more)) out[rule] = (out[rule] ?? 0) + n
  return out
}

/** One batch across the tables, in table order, at most batchSize rows. */
export function scanBatch(db: Database, options: ScanOptions): ScanResult {
  const startedAt = Date.now()
  const version = options.version ?? RULES_VERSION
  let budget = options.batchSize ?? DEFAULT_SCAN_BATCH
  const outcome = db.transaction(() => {
    let scanned = 0
    let byRule: Record<string, number> = {}
    for (const table of SCAN_TABLES) {
      if (budget <= 0) break
      const rows = unscannedRows(db, table, version, budget)
      byRule = addCounts(byRule, scanRows(db, rows, options, version))
      markScanned(db, table, rows.map((row) => row.rowId), version)
      scanned += rows.length
      budget -= rows.length
    }
    return { scanned, byRule }
  })()
  const findings = Object.values(outcome.byRule).reduce((sum, n) => sum + n, 0)
  return { ...outcome, findings, remaining: countUnscanned(db, version), ms: Date.now() - startedAt }
}

/** Batches until nothing is left or the time budget is spent (POST /data/scan). */
export function scanUntil(db: Database, options: ScanOptions, budgetMs: number): ScanResult {
  const startedAt = Date.now()
  let total: ScanResult = { scanned: 0, findings: 0, byRule: {}, remaining: countUnscanned(db, options.version ?? RULES_VERSION), ms: 0 }
  while (total.remaining > 0 && Date.now() - startedAt < budgetMs) {
    const batch = scanBatch(db, options)
    total = { scanned: total.scanned + batch.scanned, findings: total.findings + batch.findings, byRule: addCounts(total.byRule, batch.byRule), remaining: batch.remaining, ms: 0 }
    if (batch.scanned === 0) break
  }
  return { ...total, ms: Date.now() - startedAt }
}

/** The log line for a scan: counts and rule names only. */
export function describeScan(result: ScanResult): string {
  const rules = Object.entries(result.byRule).map(([rule, n]) => `${rule}:${n}`).join(',')
  return `data scan scanned=${result.scanned} findings=${result.findings}${rules !== '' ? ` rules=${rules}` : ''} remaining=${result.remaining} ms=${result.ms}`
}
