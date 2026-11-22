// The activity table (schema v18): one row per thing the Activity page
// reports, written by the daemon as it happens. A row holds a kind, ids and
// a count; `detail` is a short machine word (an error class, a version),
// checked here, so no prompt, reply or memory text can ever be stored in it.
// The table is bounded: rows older than ACTIVITY_MAX_AGE_MS or past the newest
// ACTIVITY_MAX_ROWS go, checked on every PRUNE_EVERY-th insert so no timer is needed.

import type { Database } from '../sqlite/types'

export const ACTIVITY_KINDS = [
  'recall', 'save', 'summary', 'observer-failed', 'backup', 'restore', 'update-installed', 'sign-in', 'device-paired',
] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

export const ACTIVITY_MAX_AGE_MS = 90 * 86_400_000
export const ACTIVITY_MAX_ROWS = 100_000
const PRUNE_EVERY = 1_000
const DETAIL = /^[A-Za-z0-9._:-]{1,64}$/

export interface ActivityInput {
  kind: ActivityKind
  at: number
  host?: string | null
  projectKey?: string | null
  sessionId?: number | null
  device?: string | null
  count?: number | null
  detail?: string | null
}

export interface ActivityRow {
  id: number
  at: number
  kind: ActivityKind
  host: string | null
  projectKey: string | null
  /** The project's display name, or its key. */
  project: string | null
  sessionId: number | null
  device: string | null
  count: number | null
  detail: string | null
}

export function isActivityKind(value: unknown): value is ActivityKind {
  return typeof value === 'string' && (ACTIVITY_KINDS as readonly string[]).includes(value)
}

export function recordActivity(db: Database, input: ActivityInput): void {
  if (!isActivityKind(input.kind)) throw new Error('unknown activity kind')
  const detail = typeof input.detail === 'string' && DETAIL.test(input.detail) ? input.detail : null
  const row = db.query<{ id: number }, Record<string, string | number | null>>(
    `INSERT INTO activity (at, kind, host, project_key, session_id, device, count, detail)
     VALUES ($at, $kind, $host, $projectKey, $sessionId, $device, $count, $detail) RETURNING id`,
  ).get({
    at: input.at, kind: input.kind, host: input.host ?? null, projectKey: input.projectKey ?? null, sessionId: input.sessionId ?? null,
    device: input.device ?? null, count: input.count ?? null, detail,
  })
  if (row !== null && row.id % PRUNE_EVERY === 0) pruneActivity(db, input.at)
}

/** Removes what is past the age limit or the row cap; returns how many rows went. */
export function pruneActivity(db: Database, now: number, maxRows: number = ACTIVITY_MAX_ROWS): number {
  const old = db.query('DELETE FROM activity WHERE at < $cutoff').run({ cutoff: now - ACTIVITY_MAX_AGE_MS }).changes
  const over = db.query(
    'DELETE FROM activity WHERE id IN (SELECT id FROM activity ORDER BY at DESC, id DESC LIMIT -1 OFFSET $maxRows)',
  ).run({ maxRows }).changes
  return old + over
}

export interface ActivityQuery {
  /** Null for every kind. */
  kinds: readonly ActivityKind[] | null
  limit: number
  offset: number
}

export interface ActivityPage {
  rows: ActivityRow[]
  total: number
}

export function listActivity(db: Database, query: ActivityQuery): ActivityPage {
  // Kinds come from a fixed list, so they can be inlined as literals.
  const where = query.kinds === null ? '' : `WHERE a.kind IN (${query.kinds.filter(isActivityKind).map((kind) => `'${kind}'`).join(', ') || "''"})`
  const rows = db.query<ActivityRow, { limit: number; offset: number }>(
    `SELECT a.id, a.at, a.kind, a.host, a.project_key AS projectKey, coalesce(p.display_name, a.project_key) AS project, a.session_id AS sessionId,
       a.device, a.count, a.detail
     FROM activity a LEFT JOIN projects p ON p.key = a.project_key ${where} ORDER BY a.at DESC, a.id DESC LIMIT $limit OFFSET $offset`,
  ).all({ limit: query.limit, offset: query.offset })
  const total = db.query<{ n: number }, []>(`SELECT count(*) AS n FROM activity a ${where}`).get()?.n ?? 0
  return { rows, total }
}

/** The update auto-update.json says was installed, logged once: a restart finds the row and adds nothing. */
export function recordUpdateOnce(db: Database, updated: { version: string; at: number } | null, log: (line: string) => void = () => {}): void {
  if (updated === null) return
  try {
    const seen = db.query("SELECT 1 FROM activity WHERE kind = 'update-installed' AND at = $at AND detail = $version").get({ at: updated.at, version: updated.version })
    if (seen === null) recordActivity(db, { kind: 'update-installed', at: updated.at, detail: updated.version })
  } catch (error: unknown) {
    log(`update activity not recorded: ${error instanceof Error ? error.name : 'error'}`)
  }
}

/** How many of its own events a central device keeps; it writes none to its kept store, so they live in memory. */
export const DEVICE_ACTIVITY_LIMIT = 200

export interface ActivityRing {
  push(input: ActivityInput): void
  /** Newest first, shaped like stored rows. */
  rows(): ActivityRow[]
}

/** A central device's own events (sign-ins, an update installed here), lost on restart like the rest of its in-memory state. */
export function createActivityRing(limit: number = DEVICE_ACTIVITY_LIMIT): ActivityRing {
  let rows: ActivityRow[] = []
  let next = 1
  return {
    push: (input) => {
      if (!isActivityKind(input.kind)) throw new Error('unknown activity kind')
      const detail = typeof input.detail === 'string' && DETAIL.test(input.detail) ? input.detail : null
      const row: ActivityRow = {
        id: next, at: input.at, kind: input.kind, host: input.host ?? null, projectKey: input.projectKey ?? null, project: input.projectKey ?? null,
        sessionId: input.sessionId ?? null, device: input.device ?? null, count: input.count ?? null, detail,
      }
      next += 1
      rows = [row, ...rows].slice(0, limit)
    },
    rows: () => rows,
  }
}
