// Every read a store reader worker can run, by name. Each is a plain function
// of a read-only connection (and the store's path, for file sizes) and takes
// and returns plain data, so the worker and the daemon's own connection give
// one answer. Only reads: the daemon stays the only writer.

import { recallDelivered, recallPrompt, recallRows } from '../context/recall-reads'
import { type MetricsWindow, metricsSummary } from '../dashboard/metrics'
import { sizeReport } from '../data-control/size'
import type { Database } from '../sqlite/types'
import { type BrowseFilters, browseObservations, observationFacets } from '../store/memory-reads'

export const STORE_READS = {
  /** For tests of the worker itself: answers with its argument. */
  ping: (_db: Database, _dbPath: string, args: { value: number }) => ({ value: args.value }),
  recallPrompt: (db: Database, _dbPath: string, args: Parameters<typeof recallPrompt>[1]) => recallPrompt(db, args),
  recallRows: (db: Database, _dbPath: string, args: Parameters<typeof recallRows>[1]) => recallRows(db, args),
  recallDelivered: (db: Database, _dbPath: string, args: Parameters<typeof recallDelivered>[1]) => recallDelivered(db, args),
  dataSize: (db: Database, dbPath: string, _args: Record<string, never>) => sizeReport(db, dbPath),
  metricsSummary: (db: Database, _dbPath: string, args: { window: MetricsWindow; now: number }) => metricsSummary(db, args.window, args.now),
  memoryFacets: (db: Database, _dbPath: string, _args: Record<string, never>) => observationFacets(db),
  memoryBrowse: (db: Database, _dbPath: string, args: { filters: BrowseFilters }) => browseObservations(db, args.filters),
}

export type StoreReadName = keyof typeof STORE_READS
export type StoreReadArgs<K extends StoreReadName> = Parameters<(typeof STORE_READS)[K]>[2]
export type StoreReadResult<K extends StoreReadName> = ReturnType<(typeof STORE_READS)[K]>

export function isStoreRead(op: string): op is StoreReadName {
  return Object.hasOwn(STORE_READS, op)
}

/** Runs one read by name; the worker checks the name first. */
export function runStoreRead(db: Database, dbPath: string, op: StoreReadName, args: unknown): unknown {
  return (STORE_READS[op] as (db: Database, dbPath: string, args: unknown) => unknown)(db, dbPath, args)
}
