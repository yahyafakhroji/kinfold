// Every read a store reader worker can run, by name. Each is a plain function
// of a read-only connection (and the store's path, for file sizes) and takes
// and returns plain data, so the worker and the daemon's own connection give
// one answer. Only reads: the daemon stays the only writer.

import { recallDelivered, recallDelta, recallKeyword, recallRows, recallWarm } from '../context/recall-reads'
import { type MetricsWindow, metricsSummary } from '../reports/metrics'
import { sizeReport } from '../data-control/size'
import type { Database } from '../sqlite/types'
import { type BrowseFilters, browseObservations, observationFacets } from '../store/memory-reads'
import { type ActivityQuery, listActivity } from '../store/activity-store'
import { type MemoriesQuery, type ProjectsQuery, type SessionsQuery, devicesSeen, memoriesPage, projectsPage } from '../store/list-reads'
import { type ImpactWindow, type MeasuredEntries, impactReport, overviewReport, sessionsWithSaved } from '../reports/overview'
import { hostTurns, measureSaving } from '../reports/saved'

export const STORE_READS = {
  /** For tests of the worker itself: answers with its argument. */
  ping: (_db: Database, _dbPath: string, args: { value: number }) => ({ value: args.value }),
  recallDelta: (db: Database, _dbPath: string, args: Parameters<typeof recallDelta>[1]) => recallDelta(db, args),
  recallKeyword: (db: Database, _dbPath: string, args: Parameters<typeof recallKeyword>[1]) => recallKeyword(db, args),
  recallRows: (db: Database, _dbPath: string, args: Parameters<typeof recallRows>[1]) => recallRows(db, args),
  recallWarm: (db: Database, _dbPath: string, _args: Record<string, never>) => recallWarm(db),
  recallDelivered: (db: Database, _dbPath: string, args: Parameters<typeof recallDelivered>[1]) => recallDelivered(db, args),
  dataSize: (db: Database, dbPath: string, _args: Record<string, never>) => sizeReport(db, dbPath),
  metricsSummary: (db: Database, _dbPath: string, args: { window: MetricsWindow; now: number }) => metricsSummary(db, args.window, args.now),
  memoryFacets: (db: Database, _dbPath: string, _args: Record<string, never>) => observationFacets(db),
  memoryBrowse: (db: Database, _dbPath: string, args: { filters: BrowseFilters }) => browseObservations(db, args.filters),
  dashboardSessions: (db: Database, _dbPath: string, args: { query: SessionsQuery; measured: MeasuredEntries }) => sessionsWithSaved(db, args.query, args.measured),
  dashboardMemories: (db: Database, _dbPath: string, args: { query: MemoriesQuery }) => memoriesPage(db, args.query),
  dashboardActivity: (db: Database, _dbPath: string, args: { query: ActivityQuery }) => listActivity(db, args.query),
  dashboardProjects: (db: Database, _dbPath: string, args: { query: ProjectsQuery }) => projectsPage(db, args.query),
  dashboardDevices: (db: Database, _dbPath: string, _args: Record<string, never>) => devicesSeen(db),
  measuredSaving: (db: Database, _dbPath: string, _args: Record<string, never>) => [...measureSaving(hostTurns(db))],
  overviewReport: (db: Database, _dbPath: string, args: { now: number; measured: MeasuredEntries }) => overviewReport(db, args.now, args.measured),
  impactReport: (db: Database, _dbPath: string, args: { now: number; window: ImpactWindow; measured: MeasuredEntries }) => impactReport(db, args.now, args.window, args.measured),
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
