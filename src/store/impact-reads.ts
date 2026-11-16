// What memory costs, as the store records it from schema v12 on: tokens
// Kinfold put into agents' context (injections), tokens the observer spent
// where its runner reports them (observer_runs), embedding calls (per day,
// for the whole store), and the turn usage the opt-in impact test reads from
// Claude Code's transcripts (turn_usage). Counts and ids only; the dashboard's
// impact module turns them into what the Metrics page shows.

import type { RunnerUsage } from '../observer/types'
import type { Database } from '../sqlite/types'

export const DAY_MS = 86_400_000

export interface ContextCost {
  host: string
  /** Host sessions that received memory in the window. */
  sessions: number
  /** Prompts the agent sent in the window, whether or not memory came back for them. */
  prompts: number
  /** Tokens of the session-start packs (and OpenCode's per-session pack). */
  startTokens: number
  /** Tokens added on the prompt channel. */
  promptTokens: number
  tokens: number
  /** Prompts the impact test held recall back for. */
  heldOut: number
}

/** Per agent, tokens added to context since `since`, ordered by agent. Token counts are the same chars/4 estimate the packs are budgeted with. */
export function contextCosts(db: Database, since: number): ContextCost[] {
  const sent = db.query<Omit<ContextCost, 'prompts'>, { since: number }>(
    `SELECT host, count(DISTINCT CASE WHEN held_out = 0 THEN host_session_id END) AS sessions,
       coalesce(sum(CASE WHEN channel = 'prompt' THEN 0 ELSE tokens END), 0) AS startTokens,
       coalesce(sum(CASE WHEN channel = 'prompt' THEN tokens ELSE 0 END), 0) AS promptTokens,
       coalesce(sum(tokens), 0) AS tokens, coalesce(sum(held_out), 0) AS heldOut
     FROM injections WHERE occurred_at >= $since AND channel <> 'mcp' AND late = 0 GROUP BY host`,
  ).all({ since })
  const prompts = new Map(db.query<{ host: string; n: number }, { since: number }>(
    'SELECT s.host, count(*) AS n FROM prompts p JOIN sessions s ON s.id = p.session_id WHERE p.occurred_at >= $since GROUP BY s.host',
  ).all({ since }).map((row) => [row.host, row.n]))
  const hosts = [...new Set([...sent.map((row) => row.host), ...prompts.keys()])].sort()
  return hosts.map((host) => {
    const row = sent.find((entry) => entry.host === host)
    return {
      host, sessions: row?.sessions ?? 0, prompts: prompts.get(host) ?? 0, startTokens: row?.startTokens ?? 0, promptTokens: row?.promptTokens ?? 0,
      tokens: row?.tokens ?? 0, heldOut: row?.heldOut ?? 0,
    }
  })
}

export interface ObserverCost {
  host: string
  runs: number
  /** Runs whose runner reported token usage; the sums cover these alone. */
  reported: number
  inputTokens: number
  outputTokens: number
}

export function observerCosts(db: Database, since: number): ObserverCost[] {
  return db.query<ObserverCost, { since: number }>(
    `SELECT host, count(*) AS runs, count(input_tokens) AS reported,
       coalesce(sum(input_tokens), 0) AS inputTokens, coalesce(sum(output_tokens), 0) AS outputTokens
     FROM observer_runs WHERE started_at >= $since GROUP BY host ORDER BY host`,
  ).all({ since })
}

/** What a runner said one observer call used. A runner that reports nothing leaves the row's columns NULL: unknown, not zero. */
export function setRunUsage(db: Database, runId: number, usage: RunnerUsage | undefined): void {
  if (usage === undefined || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return
  db.query('UPDATE observer_runs SET input_tokens = $input, output_tokens = $output WHERE id = $runId')
    .run({ runId, input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 })
}

/** One call to the embedding API for `texts` texts, added to its UTC day. */
export function countEmbeddingCall(db: Database, texts: number, now: number): void {
  db.query(
    `INSERT INTO embedding_calls (day, calls, texts) VALUES ($day, 1, $texts)
     ON CONFLICT (day) DO UPDATE SET calls = calls + 1, texts = texts + excluded.texts`,
  ).run({ day: Math.floor(now / DAY_MS), texts })
}

export interface EmbeddingCalls {
  calls: number
  texts: number
}

/** Calls on the days from the one holding `since` on. */
export function embeddingCalls(db: Database, since: number): EmbeddingCalls {
  const row = db.query<EmbeddingCalls, { day: number }>(
    'SELECT coalesce(sum(calls), 0) AS calls, coalesce(sum(texts), 0) AS texts FROM embedding_calls WHERE day >= $day',
  ).get({ day: Math.floor(since / DAY_MS) })
  return { calls: row?.calls ?? 0, texts: row?.texts ?? 0 }
}

export interface TurnUsageRow {
  heldOut: boolean
  projectKey: string
  /** Every token the turn's model calls processed: input, output, cache reads and cache writes. */
  tokens: number
  outputTokens: number
  toolCalls: number
  durationMs: number | null
}

/** Most recent rows the comparison reads; at one held-out turn in ten this is far past the minimum sample. */
export const TURN_USAGE_LIMIT = 20_000

export function turnUsageRows(db: Database, limit: number = TURN_USAGE_LIMIT): TurnUsageRow[] {
  return db.query<Omit<TurnUsageRow, 'heldOut'> & { heldOut: number }, { limit: number }>(
    `SELECT held_out AS heldOut, project_key AS projectKey,
       input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens AS tokens, output_tokens AS outputTokens,
       tool_calls AS toolCalls, duration_ms AS durationMs
     FROM turn_usage ORDER BY occurred_at DESC LIMIT $limit`,
  ).all({ limit }).map((row) => ({ ...row, heldOut: row.heldOut !== 0 }))
}
