// Read-only queries behind GET /metrics/summary. Only what is stored today:
// observer_runs (one row per observer call), injections (one row per pack or
// match handed to a host), event observer states, and the gap between an
// observation's newest cited event and the observation row. Each query
// returns raw rows or counts; percentiles and grouping are pure functions in
// src/dashboard/metrics.ts. Run error text is reduced to its class there.

import type { Database } from '../sqlite/types'

/** Recent rows only, so a large store answers in milliseconds. */
export const METRICS_SAMPLE_LIMIT = 5_000

export interface RunRow {
  host: string
  provider: string
  status: string
  error: string | null
  /** finished_at - started_at; null while running. */
  durationMs: number | null
}

export interface InjectionTotals {
  host: string
  channel: string
  count: number
  tokens: number
}

export interface StateCount {
  state: string
  events: number
}

export function recentRuns(db: Database, limit: number = METRICS_SAMPLE_LIMIT): RunRow[] {
  return db.query<RunRow, { limit: number }>(
    `SELECT host, provider, status, error, finished_at - started_at AS durationMs
     FROM observer_runs ORDER BY id DESC LIMIT $limit`,
  ).all({ limit })
}

export function injectionTotals(db: Database): InjectionTotals[] {
  return db.query<InjectionTotals, []>(
    `SELECT host, channel, count(*) AS count, coalesce(sum(tokens), 0) AS tokens
     FROM injections GROUP BY host, channel ORDER BY host, channel`,
  ).all()
}

/**
 * Capture-to-searchable lag per observation: created_at minus the occurred_at
 * of the newest event it cites (the observation could not exist before that
 * event). Observations whose cited events were all purged drop out.
 */
export function captureLags(db: Database, limit: number = METRICS_SAMPLE_LIMIT): number[] {
  return db.query<{ lag: number }, { limit: number }>(
    `SELECT o.created_at - max(e.occurred_at) AS lag
     FROM (SELECT id, created_at, source_event_ids FROM observations ORDER BY id DESC LIMIT $limit) o
     JOIN json_each(o.source_event_ids) j JOIN events e ON e.event_id = j.value
     GROUP BY o.id`,
  ).all({ limit }).map((row) => row.lag)
}

export function eventStates(db: Database): StateCount[] {
  return db.query<StateCount, []>(
    'SELECT observer_state AS state, count(*) AS events FROM events GROUP BY observer_state ORDER BY observer_state',
  ).all()
}

export interface InjectionDuration {
  host: string
  channel: string
  durationMs: number
}

/** Timed injections since `since` (schema v6; older rows have no duration and drop out). */
export function injectionDurations(db: Database, since: number): InjectionDuration[] {
  return db.query<InjectionDuration, { since: number }>(
    `SELECT host, channel, duration_ms AS durationMs FROM injections
     WHERE occurred_at >= $since AND duration_ms IS NOT NULL ORDER BY host, channel`,
  ).all({ since })
}
