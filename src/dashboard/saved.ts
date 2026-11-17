// Tokens saved, two ways, never added together.
//
// Measured: the opt-in impact test holds recall back for about one prompt in
// ten. Per agent, held-out turns are set beside normal turns of the projects
// that have both kinds (a project with one kind would compare projects, not
// memory). The figure is the difference of the medians, held-out minus
// normal, per turn. Whether it is more than normal variation is decided by a
// 95% bootstrap interval of that difference (BOOTSTRAP_RESAMPLES resamples of
// each group, with a fixed seed so a report repeats): above zero is a saving,
// below zero a cost, across zero "no measurable saving yet". Below
// MIN_HOLDOUT_SAMPLE turns in either group there is no measured figure.
//
// Estimate: where an agent has no measured result, what the observer spent
// making the memories a session was given (each run's reported tokens split
// evenly over the memories it made), less the tokens the session read them
// in. It is an upper bound ("up to"), floored at zero, and partial when a
// memory has no known run (written before schema v18) or its run reported no
// usage. A measured result, whatever it found, always wins over it.

import type { Database } from '../sqlite/types'
import { MIN_HOLDOUT_SAMPLE } from './impact'

export const BOOTSTRAP_RESAMPLES = 2_000
const SEED = 0x5eed

export interface HostTurn {
  host: string
  projectKey: string
  heldOut: boolean
  /** Every token the turn's model calls processed. */
  tokens: number
}

export type Measured =
  | { status: 'not-enough'; heldOut: number; normal: number; minSample: number }
  | {
    status: 'saving' | 'cost' | 'no-difference'
    /** Median held-out turn minus median normal turn: positive when memory saves. */
    perTurn: number
    /** The 95% interval of perTurn. */
    low: number
    high: number
    heldOut: number
    normal: number
  }

function median(sorted: readonly number[]): number {
  const middle = (sorted.length - 1) / 2
  return (sorted[Math.floor(middle)]! + sorted[Math.ceil(middle)]!) / 2
}

/** mulberry32: small, fast and the same on every platform. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function resampledMedian(values: readonly number[], random: () => number): number {
  const sample = Array.from({ length: values.length }, () => values[Math.floor(random() * values.length)]!)
  return median(sample.sort((a, b) => a - b))
}

function compare(held: readonly number[], normal: readonly number[], minSample: number): Measured {
  if (held.length < minSample || normal.length < minSample) return { status: 'not-enough', heldOut: held.length, normal: normal.length, minSample }
  const sortedHeld = [...held].sort((a, b) => a - b)
  const sortedNormal = [...normal].sort((a, b) => a - b)
  const random = seeded(SEED)
  const differences = Array.from({ length: BOOTSTRAP_RESAMPLES }, () => resampledMedian(held, random) - resampledMedian(normal, random)).sort((a, b) => a - b)
  const low = Math.round(differences[Math.floor(BOOTSTRAP_RESAMPLES * 0.025)]!)
  const high = Math.round(differences[Math.ceil(BOOTSTRAP_RESAMPLES * 0.975) - 1]!)
  const perTurn = Math.round(median(sortedHeld) - median(sortedNormal))
  const status = low > 0 ? 'saving' : high < 0 ? 'cost' : 'no-difference'
  return { status, perTurn, low, high, heldOut: held.length, normal: normal.length }
}

/** One result per agent that has any recorded turn. */
export function measureSaving(rows: readonly HostTurn[], minSample: number = MIN_HOLDOUT_SAMPLE): Map<string, Measured> {
  const hosts = [...new Set(rows.map((row) => row.host))].sort()
  return new Map(hosts.map((host) => {
    const own = rows.filter((row) => row.host === host)
    const withHeld = new Set(own.filter((row) => row.heldOut).map((row) => row.projectKey))
    const withNormal = new Set(own.filter((row) => !row.heldOut).map((row) => row.projectKey))
    const compared = own.filter((row) => withHeld.has(row.projectKey) && withNormal.has(row.projectKey))
    const tokens = (heldOut: boolean): number[] => compared.filter((row) => row.heldOut === heldOut).map((row) => row.tokens)
    return [host, compare(tokens(true), tokens(false), minSample)] as const
  }))
}

/** Most recent turns read for the comparison; at one held-out turn in ten this is far past the minimum sample. */
export const HOST_TURN_LIMIT = 20_000

export function hostTurns(db: Database, limit: number = HOST_TURN_LIMIT): HostTurn[] {
  return db.query<Omit<HostTurn, 'heldOut'> & { heldOut: number }, { limit: number }>(
    `SELECT host, project_key AS projectKey, held_out AS heldOut, input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens
     FROM turn_usage ORDER BY occurred_at DESC LIMIT $limit`,
  ).all({ limit }).map((row) => ({ ...row, heldOut: row.heldOut !== 0 }))
}

export interface Estimate {
  tokens: number
  partial: boolean
  /** Distinct memories the session was given. */
  memories: number
}

const ID_CHUNK = 200

/** The estimate for each session id; a session that was given nothing has zero memories. */
export function estimateSaved(db: Database, sessionIds: readonly number[]): Map<number, Estimate> {
  const estimates = new Map<number, Estimate>(sessionIds.map((id) => [id, { tokens: 0, partial: false, memories: 0 }]))
  for (let start = 0; start < sessionIds.length; start += ID_CHUNK) {
    const ids = JSON.stringify(sessionIds.slice(start, start + ID_CHUNK))
    const joined = 'FROM sessions s JOIN injections i ON i.host = s.host AND i.host_session_id = s.host_session_id'
    const shown = "s.id IN (SELECT value FROM json_each($ids)) AND i.late = 0 AND i.held_out = 0 AND i.channel <> 'mcp'"
    const spent = db.query<{ id: number; spent: number | null; unknown: number; memories: number }, { ids: string }>(
      `WITH given AS (SELECT DISTINCT s.id AS sid, CAST(j.value AS INTEGER) AS oid ${joined}, json_each(i.observation_ids) j WHERE ${shown}),
       cost AS (SELECT g.sid, r.input_tokens + r.output_tokens AS runTokens,
         (SELECT count(*) FROM observations made WHERE made.observer_run_id = o.observer_run_id) AS made
         FROM given g LEFT JOIN observations o ON o.id = g.oid LEFT JOIN observer_runs r ON r.id = o.observer_run_id)
       SELECT sid AS id, sum(CASE WHEN runTokens IS NOT NULL AND made > 0 THEN runTokens * 1.0 / made END) AS spent,
         sum(CASE WHEN runTokens IS NULL THEN 1 ELSE 0 END) AS unknown, count(*) AS memories FROM cost GROUP BY sid`,
    ).all({ ids })
    const read = new Map(db.query<{ id: number; tokens: number }, { ids: string }>(`SELECT s.id, coalesce(sum(i.tokens), 0) AS tokens ${joined} WHERE ${shown} GROUP BY s.id`)
      .all({ ids }).map((row) => [row.id, row.tokens]))
    for (const row of spent) {
      const tokens = Math.max(0, Math.round((row.spent ?? 0) - (read.get(row.id) ?? 0)))
      estimates.set(row.id, { tokens, partial: row.unknown > 0, memories: row.memories })
    }
  }
  return estimates
}

export type Saved =
  | { kind: 'measured'; status: 'saving' | 'cost' | 'no-difference'; /** Null when no difference was found. */ tokens: number | null; turnsCompared: number }
  | { kind: 'estimate'; tokens: number; partial: boolean }
  | { kind: 'none' }

/** What one session saved: the agent's measured result when it has one, else the estimate, else nothing. */
export function savedFor(session: { host: string; prompts: number }, measured: ReadonlyMap<string, Measured>, estimate: Estimate | undefined): Saved {
  const result = measured.get(session.host)
  if (result !== undefined && result.status !== 'not-enough') {
    const tokens = result.status === 'no-difference' ? null : result.perTurn * session.prompts
    return { kind: 'measured', status: result.status, tokens, turnsCompared: result.heldOut + result.normal }
  }
  if (estimate === undefined || estimate.memories === 0) return { kind: 'none' }
  return { kind: 'estimate', tokens: estimate.tokens, partial: estimate.partial }
}

export interface SavedTotals {
  measured: { tokens: number; sessions: number }
  estimate: { tokens: number; sessions: number; partial: boolean }
}

export function savedTotals(rows: readonly Saved[]): SavedTotals {
  const measured = rows.filter((row) => row.kind === 'measured')
  const estimate = rows.filter((row) => row.kind === 'estimate')
  return {
    measured: { tokens: measured.reduce((sum, row) => sum + (row.tokens ?? 0), 0), sessions: measured.length },
    estimate: { tokens: estimate.reduce((sum, row) => sum + row.tokens, 0), sessions: estimate.length, partial: estimate.some((row) => row.partial) },
  }
}
