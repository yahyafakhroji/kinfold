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
import { TURN_USAGE_LIMIT, comparableTurns, turnUsageRows } from '../store/impact-reads'
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

/** Puts the k-th smallest of `values` at index k, with nothing larger before it and nothing smaller after it (quickselect, in place). */
function selectInPlace(values: Float64Array, k: number): void {
  let low = 0
  let high = values.length - 1
  while (low < high) {
    const pivot = values[(low + high) >>> 1]!
    let left = low
    let right = high
    while (left <= right) {
      while (values[left]! < pivot) left += 1
      while (values[right]! > pivot) right -= 1
      if (left <= right) {
        const held = values[left]!
        values[left] = values[right]!
        values[right] = held
        left += 1
        right -= 1
      }
    }
    if (k <= right) high = right
    else if (k >= left) low = left
    else return
  }
}

/** The median of `values`, which it reorders: the same number sorting would give, without the sort. */
export function medianInPlace(values: Float64Array): number {
  const upper = values.length >>> 1
  selectInPlace(values, upper)
  if (values.length % 2 === 1) return values[upper]!
  // Even: the other middle value is the largest of those the selection left before it.
  let lower = values[0]!
  for (let index = 1; index < upper; index += 1) if (values[index]! > lower) lower = values[index]!
  return (lower + values[upper]!) / 2
}

/**
 * The median of one resample (as many draws, with replacement, as there are
 * values), drawn into `scratch`. The draws are the ones a sorted copy would be
 * made from, so the figures are unchanged; what changed is the cost: a fresh
 * array sorted 4,000 times per agent took about 0.9 s at the 20,000-turn cap,
 * and this takes about half of that, most of it the draws themselves.
 */
function resampledMedian(values: readonly number[], random: () => number, scratch: Float64Array): number {
  for (let index = 0; index < values.length; index += 1) scratch[index] = values[Math.floor(random() * values.length)]!
  return medianInPlace(scratch)
}

function compare(held: readonly number[], normal: readonly number[], minSample: number): Measured {
  if (held.length < minSample || normal.length < minSample) return { status: 'not-enough', heldOut: held.length, normal: normal.length, minSample }
  const sortedHeld = [...held].sort((a, b) => a - b)
  const sortedNormal = [...normal].sort((a, b) => a - b)
  const random = seeded(SEED)
  const heldScratch = new Float64Array(held.length)
  const normalScratch = new Float64Array(normal.length)
  const differences = Array.from({ length: BOOTSTRAP_RESAMPLES }, () => resampledMedian(held, random, heldScratch) - resampledMedian(normal, random, normalScratch)).sort((a, b) => a - b)
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
    const compared = comparableTurns(own)
    const tokens = (heldOut: boolean): number[] => compared.filter((row) => row.heldOut === heldOut).map((row) => row.tokens)
    return [host, compare(tokens(true), tokens(false), minSample)] as const
  }))
}

/** The same rows the Impact page compares (store/impact-reads.ts), so the two figures are drawn from one read and one limit. */
export const HOST_TURN_LIMIT = TURN_USAGE_LIMIT

export function hostTurns(db: Database, limit: number = HOST_TURN_LIMIT): HostTurn[] {
  return turnUsageRows(db, limit).map(({ host, projectKey, heldOut, tokens }) => ({ host, projectKey, heldOut, tokens }))
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
