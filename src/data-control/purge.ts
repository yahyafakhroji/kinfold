// Purge: delete what a target names, everywhere it lives. One transaction
// under secure_delete removes the rows, drops findings that pointed at them,
// deletes injections left pointing at nothing (and trims purged ids from the
// rest), merges the FTS index so deleted terms leave its pages, and rebuilds
// the packs of every project that lost a row. After commit, incremental
// vacuum returns the freed pages and a TRUNCATE checkpoint empties the WAL,
// which still held copies of the old pages. A dry run counts and changes
// nothing. Logs carry the target kind, numeric ids, counts and durations.

import { rebuildProjectPacks } from '../context/packs'
import type { Database } from '../sqlite/types'
import {
  type PurgeCounts,
  type PurgeTarget,
  affectedProjects,
  countScope,
  deleteScope,
  optimizeFts,
  purgedObservationIds,
  scopeFor,
} from '../store/purge-store'

export interface ScrubResult {
  freedPages: number
  /** False when a reader kept the WAL from being emptied; the next checkpoint finishes it. */
  walTruncated: boolean
}

export interface PurgeReport {
  dryRun: boolean
  target: PurgeTarget['kind']
  counts: PurgeCounts
  packsRebuilt: number
  scrub: ScrubResult | null
  ms: number
}

export interface PurgeOptions {
  dryRun: boolean
  now: () => number
}

/** Purged text must be overwritten, not just unlinked; refuse to run on a connection without it. */
export function ensureSecureDelete(db: Database): void {
  db.run('PRAGMA secure_delete = ON')
  const row = db.query<{ secure_delete: number }, []>('PRAGMA secure_delete').get()
  if (row?.secure_delete !== 1) throw new Error('secure_delete could not be enabled on this connection')
}

/** Returns freed pages to the OS and empties the WAL. Runs outside any transaction. */
export function scrub(db: Database): ScrubResult {
  const freeBefore = db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0
  db.query('PRAGMA incremental_vacuum').all()
  const freeAfter = db.query<{ freelist_count: number }, []>('PRAGMA freelist_count').get()?.freelist_count ?? 0
  const checkpoint = db.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()
  return { freedPages: freeBefore - freeAfter, walTruncated: checkpoint?.busy === 0 }
}

function removed(counts: PurgeCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0)
}

export function purge(db: Database, target: PurgeTarget, options: PurgeOptions): PurgeReport {
  const startedAt = Date.now()
  const scope = scopeFor(target)
  if (!options.dryRun) ensureSecureDelete(db)
  const outcome = db.transaction(() => {
    const ids = purgedObservationIds(db, scope)
    if (options.dryRun) return { counts: countScope(db, scope, ids), packsRebuilt: 0 }
    const projects = affectedProjects(db, scope)
    const counts = deleteScope(db, scope, ids)
    if (ids.length > 0) optimizeFts(db)
    const now = options.now()
    const packsRebuilt = removed(counts) === 0 ? 0 : projects.reduce((sum, key) => sum + rebuildProjectPacks(db, key, now), 0)
    return { counts, packsRebuilt }
  })()
  const scrubbed = options.dryRun || removed(outcome.counts) === 0 ? null : scrub(db)
  return { dryRun: options.dryRun, target: target.kind, ...outcome, scrub: scrubbed, ms: Date.now() - startedAt }
}

/** Numeric ids only: a project key is a path or remote slug and a host is free text, so neither is logged. */
function targetLabel(target: PurgeTarget): string {
  if (target.kind === 'observation' || target.kind === 'session' || target.kind === 'prompt' || target.kind === 'summary') return `${target.kind}=${target.id}`
  if (target.kind === 'event') return `event=${target.eventId}`
  if (target.kind === 'expire') return `expire=${target.table}`
  return target.kind
}

export function describePurge(target: PurgeTarget, report: PurgeReport): string {
  const counts = Object.entries(report.counts).filter(([, n]) => n > 0).map(([table, n]) => `${table}=${n}`).join(' ')
  const scrubbed = report.scrub === null ? '' : ` freed_pages=${report.scrub.freedPages} wal_truncated=${report.scrub.walTruncated}`
  return `data purge target=${targetLabel(target)} dry_run=${report.dryRun}${counts !== '' ? ` ${counts}` : ' nothing'} packs=${report.packsRebuilt}${scrubbed} ms=${report.ms}`
}
