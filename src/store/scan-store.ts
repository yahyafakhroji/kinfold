// Store side of the leak scanner: which rows still need a check under the
// current rules (scanned_version below it), marking them checked, and the
// in-place rewrite a "redact" resolution makes. Text fields are read here and
// handed to the scanner in memory only; nothing in this file logs them.

import type { Database } from '../sqlite/types'

export const SCAN_TABLES = ['events', 'prompts', 'observations', 'summaries'] as const
export type ScanTable = (typeof SCAN_TABLES)[number]

/** One stored row: its id as findings store it, and each text column by name. */
export interface ScanRow {
  table: ScanTable
  rowId: string
  fields: Readonly<Record<string, string | null>>
}

interface TableSpec {
  /** SQL for the id, as TEXT (findings.row_id is TEXT). */
  id: string
  /** Primary-key column the update statements match on. */
  key: string
  columns: readonly string[]
}

export const SCAN_SPECS: Readonly<Record<ScanTable, TableSpec>> = {
  events: { id: 'event_id', key: 'event_id', columns: ['payload'] },
  prompts: { id: 'CAST(id AS TEXT)', key: 'id', columns: ['text'] },
  observations: { id: 'CAST(id AS TEXT)', key: 'id', columns: ['title', 'narrative', 'facts', 'files'] },
  summaries: { id: 'CAST(id AS TEXT)', key: 'id', columns: ['request', 'learned', 'completed', 'next_steps'] },
}

type RawRow = Record<string, string | null> & { rowId: string }

function toScanRow(table: ScanTable, raw: RawRow): ScanRow {
  const fields = Object.fromEntries(SCAN_SPECS[table].columns.map((column) => [column, raw[column] ?? null]))
  return { table, rowId: raw.rowId, fields }
}

/** Oldest-checked first, so a rules bump works through the backlog in order. */
export function unscannedRows(db: Database, table: ScanTable, version: number, limit: number): ScanRow[] {
  const spec = SCAN_SPECS[table]
  return db.query<RawRow, { version: number; limit: number }>(
    `SELECT ${spec.id} AS rowId, ${spec.columns.join(', ')} FROM ${table}
     WHERE scanned_version < $version ORDER BY scanned_version, rowid LIMIT $limit`,
  ).all({ version, limit }).map((raw) => toScanRow(table, raw))
}

export function countUnscanned(db: Database, version: number): number {
  return SCAN_TABLES.reduce((total, table) => {
    const row = db.query<{ n: number }, { version: number }>(`SELECT count(*) AS n FROM ${table} WHERE scanned_version < $version`).get({ version })
    return total + (row?.n ?? 0)
  }, 0)
}

export function markScanned(db: Database, table: ScanTable, rowIds: readonly string[], version: number): void {
  const statement = db.query(`UPDATE ${table} SET scanned_version = $version WHERE ${SCAN_SPECS[table].key} = $rowId`)
  for (const rowId of rowIds) statement.run({ version, rowId })
}

export function readScanRow(db: Database, table: ScanTable, rowId: string): ScanRow | null {
  const spec = SCAN_SPECS[table]
  const raw = db.query<RawRow, { rowId: string }>(
    `SELECT ${spec.id} AS rowId, ${spec.columns.join(', ')} FROM ${table} WHERE ${spec.key} = $rowId`,
  ).get({ rowId })
  return raw === null ? null : toScanRow(table, raw)
}

/**
 * Rewrites the given text columns of one row and records that the row now
 * passed the current rules. Column names come from SCAN_SPECS, never from a
 * caller, so the SQL is built from a fixed set. Returns false if the row is gone.
 */
export function rewriteRow(db: Database, table: ScanTable, rowId: string, values: Readonly<Record<string, string | null>>, version: number): boolean {
  const spec = SCAN_SPECS[table]
  const columns = spec.columns.filter((column) => column in values)
  const assignments = [...columns.map((column, index) => `${column} = $v${index}`), 'rules_version = $version', 'scanned_version = $version']
  const params = Object.fromEntries(columns.map((column, index) => [`v${index}`, values[column] ?? null]))
  return db.query(`UPDATE ${table} SET ${assignments.join(', ')} WHERE ${spec.key} = $rowId`).run({ ...params, version, rowId }).changes > 0
}

/** Events keep their redaction notes beside the payload; a re-redaction writes the full list (old plus new). */
export function writeEventRedactions(db: Database, eventId: string, redactions: string): void {
  db.query('UPDATE events SET redactions = $redactions WHERE event_id = $eventId').run({ eventId, redactions })
}
