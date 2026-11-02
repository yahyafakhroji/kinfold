// Resolving a leak finding. "redact" re-runs the current rules over the whole
// row and writes the result in place (FTS follows through its update trigger,
// then merges; the project's packs are rebuilt when an observation or
// summary changed). "purge" deletes the row through the purge path. Either
// way every pending finding of that row is settled, since both act on the
// row, not on one rule. The old text is overwritten (secure_delete) and the
// WAL emptied afterwards, as for a purge. A rewrite keeps every marker already
// there, old or new form, and new markers carry the current epoch.

import { rebuildProjectPacks } from '../context/packs'
import { RULES_VERSION } from '../redaction/rules'
import type { Database } from '../sqlite/types'
import { type Finding, getFinding, resolveRowFindings } from '../store/findings-store'
import { type PurgeTarget, optimizeFts } from '../store/purge-store'
import { SCAN_TABLES, type ScanTable, readScanRow, rewriteRow, writeEventRedactions } from '../store/scan-store'
import { redactRow } from './detect'
import { type PurgeReport, ensureSecureDelete, purge, scrub } from './purge'

export const RESOLVE_ACTIONS = ['redact', 'purge'] as const
export type ResolveAction = (typeof RESOLVE_ACTIONS)[number]

export interface ResolveDeps {
  hmacKey: string
  /** The marker key's epoch; 0 when left out. */
  epoch?: number
  now: () => number
}

export type ResolveOutcome =
  | { ok: true; finding: Finding; purge: PurgeReport | null }
  | { ok: false; status: 404 | 409; error: string }

function rowTarget(table: ScanTable, rowId: string): PurgeTarget {
  if (table === 'events') return { kind: 'event', eventId: rowId }
  const id = Number(rowId)
  return table === 'prompts' ? { kind: 'prompt', id } : table === 'summaries' ? { kind: 'summary', id } : { kind: 'observation', id }
}

/** The project whose packs read this row, for observations and summaries. */
function packProject(db: Database, table: ScanTable, rowId: string): string | null {
  const sql = table === 'observations'
    ? 'SELECT project_key AS key FROM observations WHERE id = $id'
    : table === 'summaries' ? 'SELECT s.project_key AS key FROM summaries m JOIN sessions s ON s.id = m.session_id WHERE m.id = $id' : null
  return sql === null ? null : db.query<{ key: string }, { id: string }>(sql).get({ id: rowId })?.key ?? null
}

function redactInPlace(db: Database, table: ScanTable, rowId: string, deps: ResolveDeps): boolean {
  ensureSecureDelete(db)
  const done = db.transaction(() => {
    const row = readScanRow(db, table, rowId)
    if (row === null) return false
    const result = redactRow(row, { hmacKey: deps.hmacKey, epoch: deps.epoch ?? 0 })
    rewriteRow(db, table, rowId, result.values, RULES_VERSION)
    if (result.eventNotes !== null) writeEventRedactions(db, rowId, JSON.stringify(result.eventNotes))
    resolveRowFindings(db, table, [rowId], 'redacted', deps.now())
    if (table === 'observations') optimizeFts(db)
    const project = packProject(db, table, rowId)
    if (project !== null) rebuildProjectPacks(db, project, deps.now())
    return true
  })()
  if (done) scrub(db)
  return done
}

export function resolveFinding(db: Database, id: number, action: ResolveAction, deps: ResolveDeps): ResolveOutcome {
  const finding = getFinding(db, id)
  if (finding === null) return { ok: false, status: 404, error: 'no such finding' }
  if (finding.action !== 'pending') return { ok: false, status: 409, error: `finding is already ${finding.action}` }
  const table = SCAN_TABLES.find((name) => name === finding.table)
  if (table === undefined) return { ok: false, status: 409, error: 'finding names a table this build does not scan' }
  if (action === 'redact') {
    if (!redactInPlace(db, table, finding.rowId, deps)) return { ok: false, status: 409, error: 'the row no longer exists' }
    return { ok: true, finding: getFinding(db, id) ?? finding, purge: null }
  }
  const report = purge(db, rowTarget(table, finding.rowId), { dryRun: false, now: deps.now })
  // The purge deleted the finding with its row; report it as it ended.
  return { ok: true, finding: { ...finding, action: 'purged', resolvedAt: deps.now() }, purge: report }
}
