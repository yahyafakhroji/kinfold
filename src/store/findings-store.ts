// redaction_findings rows (schema v4). A finding names where the current
// rules matched stored text: table, row id, field path, rule and version.
// It never holds the matched value or the text around it, so listing
// findings is safe to show and to log by id.

import type { Database } from '../sqlite/types'
import type { ScanTable } from './scan-store'

export const FINDING_ACTIONS = ['pending', 'redacted', 'purged', 'expired'] as const
export type FindingAction = (typeof FINDING_ACTIONS)[number]

export interface NewFinding {
  table: ScanTable
  rowId: string
  field: string
  rule: string
  ruleVersion: number
  matches: number
  foundAt: number
}

export interface Finding {
  id: number
  table: string
  rowId: string
  field: string | null
  rule: string
  ruleVersion: number
  matches: number
  foundAt: number
  action: string
  resolvedAt: number | null
}

const COLUMNS = `id, table_name AS "table", row_id AS rowId, field, rule, rule_version AS ruleVersion, matches,
  found_at AS foundAt, coalesce(action, 'pending') AS action, resolved_at AS resolvedAt`

/** Skips a finding that is already pending for the same row, field and rule. Returns true when one was added. */
export function insertFinding(db: Database, finding: NewFinding): boolean {
  return db.query(
    `INSERT INTO redaction_findings (table_name, row_id, field, rule, rule_version, matches, found_at, action)
     SELECT $table, $rowId, $field, $rule, $ruleVersion, $matches, $foundAt, 'pending'
     WHERE NOT EXISTS (SELECT 1 FROM redaction_findings WHERE table_name = $table AND row_id = $rowId
       AND field IS $field AND rule = $rule AND action = 'pending')`,
  ).run({ ...finding }).changes > 0
}

export interface FindingQuery {
  /** Null lists every action. */
  action: FindingAction | null
  limit: number
}

export function listFindings(db: Database, query: FindingQuery): Finding[] {
  if (query.action === null) {
    return db.query<Finding, { limit: number }>(`SELECT ${COLUMNS} FROM redaction_findings ORDER BY found_at DESC, id DESC LIMIT $limit`)
      .all({ limit: query.limit })
  }
  return db.query<Finding, { action: string; limit: number }>(
    `SELECT ${COLUMNS} FROM redaction_findings WHERE action = $action ORDER BY found_at DESC, id DESC LIMIT $limit`,
  ).all({ action: query.action, limit: query.limit })
}

export function getFinding(db: Database, id: number): Finding | null {
  return db.query<Finding, { id: number }>(`SELECT ${COLUMNS} FROM redaction_findings WHERE id = $id`).get({ id })
}

/** Pending counts per rule, for the dashboard badge and `sam findings`. */
export function pendingByRule(db: Database): Record<string, number> {
  const rows = db.query<{ rule: string; n: number }, []>(
    "SELECT rule, count(*) AS n FROM redaction_findings WHERE action = 'pending' GROUP BY rule ORDER BY rule",
  ).all()
  return Object.fromEntries(rows.map((row) => [row.rule, row.n]))
}

/** Every pending finding of one row takes the action: a redact or purge fixes the whole row, not one rule. */
export function resolveRowFindings(db: Database, table: string, rowIds: readonly string[], action: FindingAction, now: number): number {
  const statement = db.query(
    `UPDATE redaction_findings SET action = $action, resolved_at = $now
     WHERE table_name = $table AND row_id = $rowId AND action = 'pending'`,
  )
  return rowIds.reduce((total, rowId) => total + statement.run({ action, now, table, rowId }).changes, 0)
}
