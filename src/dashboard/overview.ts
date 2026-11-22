// The Overview and Impact reports: plain functions of a read-only connection,
// run on the reports worker and kept by the daemon (kept-report.ts), since
// each one reads across the whole store. The measured result per agent is
// computed once (saved.ts, measureSaving) and handed in, so every report and
// list row uses the same one. Counts and ids only: an observer error leaves as
// its class, never its text.

import { errorClassOf } from '../observer/types'
import type { Database } from '../sqlite/types'
import { type Page, type SessionHeader, type SessionListRow, type SessionsQuery, sessionHeader, sessionsPage } from '../store/list-reads'
import { impactSummary, type ImpactSummary } from './impact'
import { type Measured, type Saved, type SavedTotals, estimateSaved, savedFor, savedTotals } from './saved'

const DAY_MS = 86_400_000
export const IMPACT_WINDOWS = { '7d': 7 * DAY_MS, '30d': 30 * DAY_MS } as const
export type ImpactWindow = keyof typeof IMPACT_WINDOWS
export type MeasuredEntries = readonly (readonly [string, Measured])[]

export interface FailingAgent {
  host: string
  provider: string
  errorClass: string
  at: number
}

export interface OverviewReport {
  memories: number
  projects: number
  sessions: number
  week: { sessions: number; prompts: number; promptsWithMemory: number }
  /** Over sessions started in the last 7 days. */
  saved: SavedTotals
  /** Agents whose latest summary run failed. */
  failing: FailingAgent[]
  /** When v18's records (devices, run links, activity) start; null on a store that never stamped it. */
  recordsSince: number | null
}

/** Saved figures for the sessions started since `since`, one per session. */
function savedSince(db: Database, since: number, measured: ReadonlyMap<string, Measured>): Saved[] {
  const sessions = db.query<{ id: number; host: string; prompts: number }, { since: number }>(
    'SELECT s.id, s.host, (SELECT count(*) FROM prompts WHERE session_id = s.id) AS prompts FROM sessions s WHERE s.started_at >= $since',
  ).all({ since })
  const estimates = estimateSaved(db, sessions.map((row) => row.id))
  return sessions.map((row) => savedFor(row, measured, estimates.get(row.id)))
}

function failingAgents(db: Database): FailingAgent[] {
  return db.query<{ host: string; provider: string; status: string; error: string | null; at: number }, []>(
    // SQLite fills the bare columns from the row that holds the max(), so this is each agent's latest finished run in one pass.
    `SELECT host, provider, status, error, max(finished_at) AS at FROM observer_runs WHERE finished_at IS NOT NULL GROUP BY host ORDER BY host`,
  ).all().filter((row) => row.status === 'failed').map((row) => ({ host: row.host, provider: row.provider, errorClass: errorClassOf(row.error), at: row.at }))
}

const count = (db: Database, sql: string, bindings: Record<string, number> = {}): number => db.query<{ n: number }, Record<string, number>>(sql).get(bindings)?.n ?? 0

export function overviewReport(db: Database, now: number, measured: MeasuredEntries): OverviewReport {
  const since = now - 7 * DAY_MS
  const week = db.query<{ prompts: number; promptsWithMemory: number | null }, { since: number }>(
    `SELECT count(*) AS prompts, sum(EXISTS (SELECT 1 FROM injections i WHERE i.session_id = p.session_id AND i.prompt_number = p.prompt_number
       AND i.channel = 'prompt' AND i.late = 0 AND i.held_out = 0 AND i.observation_ids <> '[]')) AS promptsWithMemory
     FROM prompts p WHERE p.occurred_at >= $since`,
  ).get({ since })
  const recordsSince = db.query<{ value: number | null }, []>("SELECT value FROM data_settings WHERE key = 'records.since'").get()?.value ?? null
  return {
    memories: count(db, 'SELECT count(*) AS n FROM observations'),
    projects: count(db, 'SELECT count(*) AS n FROM projects WHERE merged_into IS NULL'),
    sessions: count(db, 'SELECT count(*) AS n FROM sessions'),
    week: { sessions: count(db, 'SELECT count(*) AS n FROM sessions WHERE started_at >= $since', { since }), prompts: week?.prompts ?? 0, promptsWithMemory: week?.promptsWithMemory ?? 0 },
    saved: savedTotals(savedSince(db, since, new Map(measured))),
    failing: failingAgents(db),
    recordsSince,
  }
}

export interface ImpactReport extends ImpactSummary {
  /** Per agent with any recorded impact-test turn. */
  measured: [string, Measured][]
  saved: SavedTotals
}

export function impactReport(db: Database, now: number, window: ImpactWindow, measured: MeasuredEntries): ImpactReport {
  const since = now - IMPACT_WINDOWS[window]
  return { ...impactSummary(db, since, window), measured: measured.map(([host, result]) => [host, result]), saved: savedTotals(savedSince(db, since, new Map(measured))) }
}

export type SessionWithSaved = SessionListRow & { saved: Saved }

/** A page of sessions, each with what it saved by the same rule as the totals. */
export function sessionsWithSaved(db: Database, query: SessionsQuery, measured: MeasuredEntries): Page<SessionWithSaved> {
  const page = sessionsPage(db, query)
  const estimates = estimateSaved(db, page.rows.map((row) => row.id))
  const byHost = new Map(measured)
  return { ...page, rows: page.rows.map((row) => ({ ...row, saved: savedFor(row, byHost, estimates.get(row.id)) })) }
}

export function sessionHeaderWithSaved(db: Database, id: number, measured: MeasuredEntries): (SessionHeader & { saved: Saved }) | null {
  const header = sessionHeader(db, id)
  if (header === null) return null
  return { ...header, saved: savedFor(header, new Map(measured), estimateSaved(db, [id]).get(id)) }
}
