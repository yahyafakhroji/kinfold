// The Metrics page's impact block. Two parts, both measured:
//   costs: tokens Kinfold added to context per agent (per session and per
//     prompt), observer tokens where the provider reports them, embedding
//     calls. Over the chosen window, counted from the day the store reached
//     schema v12.
//   the holdout comparison: when the opt-in impact test is on, about one
//     Claude Code prompt in ten goes without recalled memory. Turns of the two
//     kinds are set side by side: median and quartiles of tokens, tool calls
//     and time per turn, each with its sample size.
// It reports no "tokens saved" figure and no verdict. Below a minimum sample
// in either group it says there are not enough turns yet and gives no numbers
// to compare: a difference read off a handful of turns would be noise.

import { HOLDOUT_HOSTS } from '../context/holdout'
import type { Database } from '../sqlite/types'
import { readDisplaySettings } from '../store/display-settings'
import { type ContextCost, type EmbeddingCalls, type ObserverCost, type TurnUsageRow, comparableTurns, contextCosts, embeddingCalls, observerCosts, turnUsageRows } from '../store/impact-reads'

/** Turns needed in each group before the two are compared. */
export const MIN_HOLDOUT_SAMPLE = 30

export type TurnSample = TurnUsageRow

export interface Spread {
  n: number
  median: number | null
  /** The 25th percentile. */
  low: number | null
  /** The 75th percentile. */
  high: number | null
}

/** Linear interpolation between the two nearest ranks, as a spreadsheet's QUARTILE does. */
function quantile(sorted: readonly number[], q: number): number {
  const at = (sorted.length - 1) * q
  const below = Math.floor(at)
  const above = Math.ceil(at)
  return sorted[below]! + (sorted[above]! - sorted[below]!) * (at - below)
}

export function spread(values: readonly number[]): Spread {
  if (values.length === 0) return { n: 0, median: null, low: null, high: null }
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, median: quantile(sorted, 0.5), low: quantile(sorted, 0.25), high: quantile(sorted, 0.75) }
}

export const HOLDOUT_METRICS = ['tokens', 'outputTokens', 'toolCalls', 'durationMs'] as const
export type HoldoutMetricName = (typeof HOLDOUT_METRICS)[number]

export interface HoldoutMetric {
  name: HoldoutMetricName
  heldOut: Spread
  normal: Spread
}

export interface HoldoutComparison {
  /** False until both groups hold `minSample` turns; `metrics` is then empty. */
  enough: boolean
  minSample: number
  /** Turns in each compared group: those of projects that have both kinds. */
  heldOut: number
  normal: number
  /** Every turn recorded, compared or not, so the page can show the test is collecting. */
  recorded: { heldOut: number; normal: number }
  metrics: HoldoutMetric[]
}

/**
 * Held-out turns beside normal turns of the same projects. A project with
 * turns of only one kind is left out: its turns would shift one group by what
 * that project is like, not by what memory does.
 */
export function holdoutComparison(rows: readonly TurnSample[], minSample: number = MIN_HOLDOUT_SAMPLE): HoldoutComparison {
  const compared = comparableTurns(rows)
  const held = compared.filter((row) => row.heldOut)
  const normal = compared.filter((row) => !row.heldOut)
  const enough = held.length >= minSample && normal.length >= minSample
  const values = (group: readonly TurnSample[], name: HoldoutMetricName): number[] => group.map((row) => row[name]).filter((value): value is number => value !== null)
  const recordedHeld = rows.filter((row) => row.heldOut).length
  return {
    enough, minSample, heldOut: held.length, normal: normal.length, recorded: { heldOut: recordedHeld, normal: rows.length - recordedHeld },
    metrics: enough ? HOLDOUT_METRICS.map((name) => ({ name, heldOut: spread(values(held, name)), normal: spread(values(normal, name)) })) : [],
  }
}

export interface ContextCostView extends ContextCost {
  /** Null for an agent with no session that received memory in the window. */
  tokensPerSession: number | null
  /** Prompt-channel tokens over every prompt, including the ones that got nothing; null with no prompt. */
  tokensPerPrompt: number | null
}

export interface ImpactSummary {
  window: string
  since: number
  /** When this store started recording these numbers (its upgrade to schema v12); null if never stamped. */
  countingSince: number | null
  context: ContextCostView[]
  observer: ObserverCost[]
  /** For the whole store, not per agent: the indexer embeds observations of every agent in one batch. */
  embedding: EmbeddingCalls
  holdout: {
    on: boolean
    /** The agents a prompt can be held out for. */
    hosts: readonly string[]
    /** Over every turn recorded so far, not the window: the sample builds slowly at one prompt in ten. */
    comparison: HoldoutComparison
  }
}

const per = (total: number, count: number): number | null => (count === 0 ? null : Math.round(total / count))

export function impactSummary(db: Database, since: number, window: string): ImpactSummary {
  const settings = readDisplaySettings(db)
  return {
    window, since, countingSince: settings.since,
    context: contextCosts(db, since).map((row) => ({ ...row, tokensPerSession: per(row.tokens, row.sessions), tokensPerPrompt: per(row.promptTokens, row.prompts) })),
    observer: observerCosts(db, since),
    embedding: embeddingCalls(db, since),
    holdout: { on: settings.holdout, hosts: HOLDOUT_HOSTS, comparison: holdoutComparison(turnUsageRows(db)) },
  }
}
