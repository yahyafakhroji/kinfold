// GET /metrics/summary: the dashboard's metrics page, built from what the
// store already records (src/store/metrics-reads.ts). Everything here is a
// pure function over rows, so tests can check the numbers on seeded data.
// A run's stored error is "<class>: <detail>"; only a known class leaves this
// module, anything else counts as "other", so no free text reaches the page.

// It also reports `latency`: capture-to-searchable split into stages and the two
// lag definitions, over a window of 24 h or 7 d (?window=), overall and per
// host and provider.

// Over the same window it reports `injectionLatency` (duration_ms per host and
// channel, p50/p95) and `hitRate`, two proxies for whether injected memory is
// used (src/dashboard/hit-rate.ts says what each one does and does not show).

import { OBSERVER_ERROR_CLASSES, type ObserverErrorClass } from '../observer/types'
import type { Database } from '../sqlite/types'
import { type EventStageRow, type TurnLagRow, eventStages, turnLags } from '../store/latency-reads'
import { injectedIdsSince, mcpReadsSince } from '../store/mcp-read-store'
import { type InjectionDuration, type InjectionTotals, type RunRow, type StateCount, captureLags, eventStates, injectionDurations, injectionTotals, recentRuns } from '../store/metrics-reads'
import { relatedServedSince } from '../store/related-served-store'
import { type HitRateSummary, summarizeHitRate } from './hit-rate'

export interface Percentiles {
  samples: number
  p50: number | null
  p95: number | null
}

export interface RunGroup {
  host: string
  provider: string
  runs: number
  succeeded: number
  failed: number
  running: number
  /** succeeded / (succeeded + failed); null before any run finished. */
  successRate: number | null
  durationMs: Percentiles
  errorClasses: Record<string, number>
}

export const METRICS_WINDOWS = { '24h': 24 * 3_600_000, '7d': 7 * 24 * 3_600_000 } as const
export type MetricsWindow = keyof typeof METRICS_WINDOWS
export const DEFAULT_METRICS_WINDOW: MetricsWindow = '24h'

export interface StagePercentiles {
  /** Spool and drain: ingested_at - occurred_at. */
  ingestMs: Percentiles
  /** Waiting for a batch: run started_at - ingested_at. */
  schedulerMs: Percentiles
  /** The observer call: finished_at - started_at. */
  runMs: Percentiles
  /** Observation created_at - run finished_at. */
  writeMs: Percentiles
  /** Lag from event: observation created_at - event occurred_at. */
  lagFromEventMs: Percentiles
  /** Lag from turn end: first run finished after the turn_end - its occurred_at. */
  lagFromTurnEndMs: Percentiles
}

export interface LatencyGroup extends StagePercentiles {
  host: string
  provider: string
}

export interface LatencySummary {
  window: MetricsWindow
  since: number
  all: StagePercentiles
  groups: LatencyGroup[]
}

export interface InjectionLatency {
  host: string
  channel: string
  durationMs: Percentiles
}

export interface MetricsSummary {
  runs: RunGroup[]
  injections: InjectionTotals[]
  captureLagMs: Percentiles
  queue: StateCount[]
  latency: LatencySummary
  /** Time to build or match each injection in the window, per host and channel. */
  injectionLatency: InjectionLatency[]
  /** Proxies only: fetch-after-inject and search-hit over the window. */
  hitRate: HitRateSummary & { window: MetricsWindow; since: number }
}

/** Nearest-rank percentile of unsorted values; null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(1, Math.ceil(p * sorted.length))
  return sorted[rank - 1] ?? null
}

export function percentiles(values: readonly number[]): Percentiles {
  return { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) }
}

/** The class part of a stored run error; unknown shapes become "other". */
export function errorClassOf(error: string | null): ObserverErrorClass | 'other' {
  const head = (error ?? '').split(':')[0]?.trim() ?? ''
  return OBSERVER_ERROR_CLASSES.includes(head as ObserverErrorClass) ? (head as ObserverErrorClass) : 'other'
}

function summarizeGroup(host: string, provider: string, rows: readonly RunRow[]): RunGroup {
  const succeeded = rows.filter((row) => row.status === 'succeeded').length
  const failedRows = rows.filter((row) => row.status === 'failed')
  const finished = succeeded + failedRows.length
  const durations = rows.filter((row) => row.status !== 'running' && row.durationMs !== null).map((row) => row.durationMs as number)
  const errorClasses = failedRows.reduce<Record<string, number>>((counts, row) => {
    const name = errorClassOf(row.error)
    return { ...counts, [name]: (counts[name] ?? 0) + 1 }
  }, {})
  return {
    host,
    provider,
    runs: rows.length,
    succeeded,
    failed: failedRows.length,
    running: rows.length - finished,
    successRate: finished === 0 ? null : succeeded / finished,
    durationMs: percentiles(durations),
    errorClasses,
  }
}

/** One group per (host, provider), ordered by host then provider. */
export function groupRuns(rows: readonly RunRow[]): RunGroup[] {
  const keys = [...new Set(rows.map((row) => JSON.stringify([row.host, row.provider])))].sort()
  return keys.map((key) => {
    const [host, provider] = JSON.parse(key) as [string, string]
    return summarizeGroup(host, provider, rows.filter((row) => row.host === host && row.provider === provider))
  })
}

export function stagePercentiles(stages: readonly EventStageRow[], turns: readonly TurnLagRow[]): StagePercentiles {
  return {
    ingestMs: percentiles(stages.map((row) => row.ingestMs)),
    schedulerMs: percentiles(stages.map((row) => row.schedulerMs)),
    runMs: percentiles(stages.map((row) => row.runMs)),
    writeMs: percentiles(stages.map((row) => row.writeMs)),
    lagFromEventMs: percentiles(stages.map((row) => row.lagMs)),
    lagFromTurnEndMs: percentiles(turns.map((row) => row.lagMs)),
  }
}

/** Overall and per (host, provider), ordered by host then provider. */
export function summarizeLatency(stages: readonly EventStageRow[], turns: readonly TurnLagRow[], window: MetricsWindow, since: number): LatencySummary {
  const key = (row: { host: string; provider: string }): string => JSON.stringify([row.host, row.provider])
  const keys = [...new Set([...stages, ...turns].map(key))].sort()
  const groups = keys.map((k) => {
    const [host, provider] = JSON.parse(k) as [string, string]
    return { host, provider, ...stagePercentiles(stages.filter((row) => key(row) === k), turns.filter((row) => key(row) === k)) }
  })
  return { window, since, all: stagePercentiles(stages, turns), groups }
}

/** One row per (host, channel), ordered by host then channel. */
export function summarizeInjectionLatency(rows: readonly InjectionDuration[]): InjectionLatency[] {
  const key = (row: InjectionDuration): string => JSON.stringify([row.host, row.channel])
  return [...new Set(rows.map(key))].sort().map((k) => {
    const [host, channel] = JSON.parse(k) as [string, string]
    return { host, channel, durationMs: percentiles(rows.filter((row) => key(row) === k).map((row) => row.durationMs)) }
  })
}

export function parseMetricsWindow(value: string | null): MetricsWindow | null {
  if (value === null || value === '') return DEFAULT_METRICS_WINDOW
  return Object.hasOwn(METRICS_WINDOWS, value) ? (value as MetricsWindow) : null
}

export function metricsSummary(db: Database, window: MetricsWindow = DEFAULT_METRICS_WINDOW, now: number = Date.now()): MetricsSummary {
  const since = now - METRICS_WINDOWS[window]
  return {
    runs: groupRuns(recentRuns(db)),
    injections: injectionTotals(db),
    captureLagMs: percentiles(captureLags(db)),
    queue: eventStates(db),
    latency: summarizeLatency(eventStages(db, since), turnLags(db, since), window, since),
    injectionLatency: summarizeInjectionLatency(injectionDurations(db, since)),
    hitRate: { window, since, ...summarizeHitRate(injectedIdsSince(db, since), mcpReadsSince(db, since), relatedServedSince(db, since)) },
  }
}

/** GET /metrics/summary?window=24h|7d (default 24h). */
export function metricsRoute(db: Database, window: string | null, now: () => number = Date.now): { status: number; body: unknown } {
  const parsed = parseMetricsWindow(window)
  if (parsed === null) return { status: 400, body: { error: 'window must be 24h or 7d' } }
  return { status: 200, body: metricsSummary(db, parsed, now()) }
}
