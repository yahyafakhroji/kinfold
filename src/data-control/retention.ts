// Retention, per table, from data_settings. Event payloads and prompt texts
// past their days are replaced with a marker (row and metadata stay); their
// pending findings settle as 'expired', since the text they named is gone.
// Observations and summaries past their days are deleted through the purge
// path, so FTS, injections, findings and packs follow. MCP read reports
// (mcp_reads) follow the events setting and are deleted. Every step
// skips rows it already handled, so running it twice changes nothing the
// second time.

import type { Database } from '../sqlite/types'
import { type DataSettings, type DataSettingsChange, RETENTION_TABLES, type RetentionTable, readDataSettings } from '../store/data-settings-store'
import { resolveRowFindings } from '../store/findings-store'
import { expireRelatedServed } from '../store/related-served-store'
import { type ExpiringRows, countExpiring, expireEventPayloads, expireMcpReads, expirePromptTexts } from '../store/retention-store'
import { ensureSecureDelete, purge, scrub } from './purge'

export const DAY_MS = 86_400_000
export const RETENTION_BATCH = 500
/** Batches per run; the next tick carries on with the rest. */
const MAX_BATCHES = 20

export interface RetentionOutcome {
  events: number
  prompts: number
  observations: number
  summaries: number
  /** MCP read reports deleted (they follow the events setting). */
  mcpReads: number
  findingsExpired: number
  ms: number
}

type Expire = (db: Database, cutoff: number, now: number, limit: number) => string[]

function expireText(db: Database, table: 'events' | 'prompts', expire: Expire, cutoff: number, now: number): { rows: number; findings: number } {
  let rows = 0
  let findings = 0
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const ids = db.transaction(() => {
      const expired = expire(db, cutoff, now, RETENTION_BATCH)
      findings += resolveRowFindings(db, table, expired, 'expired', now)
      return expired
    })()
    rows += ids.length
    if (ids.length < RETENTION_BATCH) break
  }
  return { rows, findings }
}

function expireReads(db: Database, cutoff: number): number {
  let rows = 0
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const deleted = db.transaction(() => expireMcpReads(db, cutoff, RETENTION_BATCH))()
    rows += deleted
    if (deleted < RETENTION_BATCH) break
  }
  // The related lines served at prompt time are only useful next to those reads, so they age with them.
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    if (db.transaction(() => expireRelatedServed(db, cutoff, RETENTION_BATCH))() < RETENTION_BATCH) break
  }
  return rows
}

function cutoffFor(days: number | null, now: number): number | null {
  return days === null ? null : now - days * DAY_MS
}

export function applyRetention(db: Database, now: number): RetentionOutcome {
  const startedAt = Date.now()
  const { retention } = readDataSettings(db)
  ensureSecureDelete(db)
  const eventsCutoff = cutoffFor(retention.events, now)
  const promptsCutoff = cutoffFor(retention.prompts, now)
  const events = eventsCutoff === null ? { rows: 0, findings: 0 } : expireText(db, 'events', expireEventPayloads, eventsCutoff, now)
  const prompts = promptsCutoff === null ? { rows: 0, findings: 0 } : expireText(db, 'prompts', expirePromptTexts, promptsCutoff, now)
  const deleted = (['observations', 'summaries'] as const).map((table) => {
    const cutoff = cutoffFor(retention[table], now)
    return cutoff === null ? 0 : purge(db, { kind: 'expire', table, before: cutoff }, { dryRun: false, now: () => now }).counts[table]
  })
  const mcpReads = eventsCutoff === null ? 0 : expireReads(db, eventsCutoff)
  // purge scrubs after its own deletes; text expiry and read deletes need one of their own.
  if (events.rows + prompts.rows + mcpReads > 0) scrub(db)
  return {
    events: events.rows,
    prompts: prompts.rows,
    observations: deleted[0] ?? 0,
    summaries: deleted[1] ?? 0,
    mcpReads,
    findingsExpired: events.findings + prompts.findings,
    ms: Date.now() - startedAt,
  }
}

export interface RetentionPreview {
  /** The settings the preview assumed: the stored ones with the change laid over them. Nothing was saved. */
  settings: DataSettings
  /** What a save would expire at once, per table; zero rows for a table kept forever. */
  tables: Record<RetentionTable, ExpiringRows>
  ms: number
}

/** The settings a change would leave, without writing them. */
export function mergeRetention(current: DataSettings, change: DataSettingsChange): DataSettings {
  return { retention: { ...current.retention, ...change.retention }, warnBytes: change.warnBytes ?? current.warnBytes }
}

/** Read-only: what saving `change` would expire right away (same rules as applyRetention). */
export function previewRetention(db: Database, change: DataSettingsChange, now: number): RetentionPreview {
  const startedAt = Date.now()
  const settings = mergeRetention(readDataSettings(db), change)
  const tables = Object.fromEntries(RETENTION_TABLES.map((table) => {
    const cutoff = cutoffFor(settings.retention[table], now)
    return [table, cutoff === null ? { rows: 0, bytes: 0 } : countExpiring(db, table, cutoff)]
  })) as Record<RetentionTable, ExpiringRows>
  return { settings, tables, ms: Date.now() - startedAt }
}

export function describePreview(preview: RetentionPreview): string {
  const counts = RETENTION_TABLES.map((table) => `${table}=${preview.tables[table].rows}`).join(' ')
  return `data retention preview ${counts} ms=${preview.ms}`
}

/** Null when nothing expired, so an idle tick logs nothing. */
export function describeRetention(outcome: RetentionOutcome): string | null {
  const { events, prompts, observations, summaries, mcpReads, findingsExpired, ms } = outcome
  if (events + prompts + observations + summaries + mcpReads === 0) return null
  return `data retention events=${events} prompts=${prompts} observations=${observations} summaries=${summaries} mcp_reads=${mcpReads} findings_expired=${findingsExpired} ms=${ms}`
}
