// What `kinfold watch` shows, read from the store: one row per prompt, with
// the memory the prompt channel sent for it. A prompt is the unit rather than
// an injection because an answer that carried nothing records no injection,
// and the user still wants to see that the prompt was seen. Rows hold ids,
// titles, an agent and a project name; never prompt or reply text.
// A watcher that asks also gets session starts: the first pack each session
// was sent, as the list a hook shows at session start. An agent whose plugin
// cannot print at session start (OpenCode, Kilo Code) toasts it from here.

import { FIRST_SCREEN_ROWS, HELD_OUT_LINE, type Recalled, firstScreenToast, lateLine, recallLine } from '../context/recall-line'
import type { RouteAnswer } from '../daemon/data-routes'
import type { Database } from '../sqlite/types'
import { firstScreenFor, titlesFor } from '../store/context-store'
import { recentMerges } from '../store/project-merge'
import { RECENT_MERGE_MS } from '../daemon/project-routes'

/**
 * A prompt is shown this long after its event time. The hook asks for recall
 * after it spools the prompt, and the injection is tied to its prompt when
 * the prompt is ingested; by then both have landed.
 */
export const WATCH_SETTLE_MS = 1_500
export const WATCH_LIMIT = 100

export interface WatchRow {
  /** The prompt's row id: the cursor a watcher hands back. */
  id: number
  at: number
  host: string
  /** The project's display name. */
  project: string
  ids: number[]
  recalled: Recalled[]
  heldOut: boolean
  /** The answer came after the agent stopped waiting, so it was probably not shown. */
  late: boolean
  /** The agent's own id for the session, and the prompt's number in it: what a plugin needs to show the line in the right place. */
  hostSessionId: string
  promptNumber: number
  /** The recall line as an agent would show it, built from `ids`. */
  line: string
}

export interface WatchQuery {
  afterId: number
  /** Prompts newer than this are not shown yet, nor any after them, so a cursor never passes one that is still settling. */
  before: number
  host: string | null
  /** A project key, or its display name in any case. */
  project: string | null
  limit: number
}

interface PromptRow {
  id: number
  at: number
  promptNumber: number
  host: string
  hostSessionId: string
  project: string
}

interface InjectionRow {
  ids: string
  heldOut: number
  relatedCount: number
  late: number
}

function parseIds(json: string): number[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)) : []
  } catch {
    return []
  }
}

/** 0 on a store with no prompt yet. */
export function latestPromptId(db: Database): number {
  return db.query<{ id: number }, []>('SELECT coalesce(max(id), 0) AS id FROM prompts').get()?.id ?? 0
}

export function watchRows(db: Database, query: WatchQuery): WatchRow[] {
  const prompts = db.query<PromptRow, Record<string, string | number | null>>(
    `SELECT p.id, p.occurred_at AS at, p.prompt_number AS promptNumber, s.host, s.host_session_id AS hostSessionId, pr.display_name AS project
     FROM prompts p JOIN sessions s ON s.id = p.session_id JOIN projects pr ON pr.key = s.project_key
     WHERE p.id > $afterId AND ($host IS NULL OR s.host = $host)
       AND ($project IS NULL OR pr.key = $project OR lower(pr.display_name) = lower($project))
     ORDER BY p.id LIMIT $limit`,
  ).all({ afterId: query.afterId, host: query.host, project: query.project, limit: query.limit })
  const tooFresh = prompts.findIndex((row) => row.at > query.before)
  const settled = tooFresh === -1 ? prompts : prompts.slice(0, tooFresh)
  const sent = db.query<InjectionRow, { host: string; hostSessionId: string; promptNumber: number }>(
    `SELECT observation_ids AS ids, held_out AS heldOut, related_count AS relatedCount, late FROM injections
     WHERE host = $host AND host_session_id = $hostSessionId AND channel = 'prompt' AND prompt_number = $promptNumber ORDER BY id`,
  )
  return settled.map((prompt) => {
    const injections = sent.all({ host: prompt.host, hostSessionId: prompt.hostSessionId, promptNumber: prompt.promptNumber })
    // In each row the related ids are the last ones (the delta comes first).
    const parts = injections.flatMap((row) => {
      const ids = parseIds(row.ids)
      return ids.map((id, index) => ({ id, part: index >= ids.length - row.relatedCount ? 'related' as const : 'new' as const }))
    })
    const titles = titlesFor(db, parts.map((entry) => entry.id))
    const ids = parts.map((entry) => entry.id)
    const recalled = parts.map((entry) => ({ id: entry.id, title: titles.get(entry.id) ?? '', part: entry.part }))
    const heldOut = injections.some((row) => row.heldOut !== 0)
    const late = injections.length > 0 && injections.every((row) => row.late !== 0)
    return {
      id: prompt.id, at: prompt.at, host: prompt.host, project: prompt.project, ids, recalled, heldOut, late,
      hostSessionId: prompt.hostSessionId, promptNumber: prompt.promptNumber,
      line: heldOut ? HELD_OUT_LINE : late ? lateLine(recallLine(ids, recalled)) : recallLine(ids, recalled),
    }
  })
}

export interface WatchStart {
  /** The injection's row id: the cursor a watcher hands back. */
  id: number
  at: number
  host: string
  project: string
  hostSessionId: string
  /** The pack's ids: the list names these and no other. */
  ids: number[]
  /** The session-start list, sized for a toast. */
  list: string
}

export interface WatchStartsQuery {
  afterId: number
  host: string | null
  project: string | null
  limit: number
  now: number
}

/** 0 on a store that has sent nothing yet. */
export function latestInjectionId(db: Database): number {
  return db.query<{ id: number }, []>('SELECT coalesce(max(id), 0) AS id FROM injections').get()?.id ?? 0
}

interface StartRow {
  id: number
  at: number
  host: string
  hostSessionId: string
  projectKey: string
  project: string
  ids: string
}

/**
 * The first pack each session was sent, after `afterId`. A session that asks
 * for its pack again (OpenCode does after a compaction) is not a new start,
 * and an empty pack records no injection, so it has no row here.
 */
export function watchStarts(db: Database, query: WatchStartsQuery): WatchStart[] {
  const rows = db.query<StartRow, Record<string, string | number | null>>(
    `SELECT i.id, i.occurred_at AS at, i.host, i.host_session_id AS hostSessionId, i.project_key AS projectKey, pr.display_name AS project, i.observation_ids AS ids
     FROM injections i JOIN projects pr ON pr.key = i.project_key
     WHERE i.id > $afterId AND i.channel IN ('session_start', 'request') AND i.host_session_id IS NOT NULL
       AND ($host IS NULL OR i.host = $host)
       AND ($project IS NULL OR pr.key = $project OR lower(pr.display_name) = lower($project))
       AND NOT EXISTS (SELECT 1 FROM injections e WHERE e.host = i.host AND e.host_session_id = i.host_session_id
                       AND e.channel IN ('session_start', 'request') AND e.id < i.id)
     ORDER BY i.id LIMIT $limit`,
  ).all({ afterId: query.afterId, host: query.host, project: query.project, limit: query.limit })
  return rows.map((row) => {
    const ids = parseIds(row.ids)
    const screen = firstScreenFor(db, { projectKey: row.projectKey, host: row.host, hostSessionId: row.hostSessionId, ids, rows: FIRST_SCREEN_ROWS })
    return { id: row.id, at: row.at, host: row.host, project: row.project, hostSessionId: row.hostSessionId, ids, list: firstScreenToast(screen, ids, query.now) }
  })
}

export const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const MAX_PROJECT_CHARS = 300

/**
 * GET /watch[?after=<id>][&startsAfter=now|<id>][&host=][&project=] (token
 * only). Without `after` it answers the current cursor and no rows, so a
 * watcher starts from now; with it, the settled prompts after that id and the
 * cursor to ask from next. `startsAfter` adds session starts the same way,
 * under their own cursor; a watcher that leaves it out gets none.
 */
export function watchRoute(db: Database, method: string, url: URL, now: number): RouteAnswer {
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
  const after = url.searchParams.get('after')
  const host = url.searchParams.get('host')
  const project = url.searchParams.get('project')
  if (after !== null && !/^\d{1,15}$/.test(after)) return { status: 400, body: { error: 'after must be a prompt id' } }
  if (host !== null && !HOST_PATTERN.test(host)) return { status: 400, body: { error: 'host must be an agent id' } }
  if (project !== null && (project === '' || project.length > MAX_PROJECT_CHARS)) return { status: 400, body: { error: 'project must be a name or key' } }
  const startsAfter = url.searchParams.get('startsAfter')
  if (startsAfter !== null && startsAfter !== 'now' && !/^\d{1,15}$/.test(startsAfter)) return { status: 400, body: { error: 'startsAfter must be now or an id' } }
  // A watcher says each of the day's project merges once (watch/cli.ts): one repo under two keys became one project.
  const merges = recentMerges(db, now - RECENT_MERGE_MS)
  const starts = { ...(startsAfter === null ? {} : startsPart(db, startsAfter === 'now' ? null : Number(startsAfter), host, project, now)), ...(merges.length > 0 ? { merges } : {}) }
  if (after === null) return { status: 200, body: { cursor: latestPromptId(db), rows: [], ...starts } }
  const afterId = Number(after)
  const newest = latestPromptId(db)
  // The same for prompts: a cursor from a store that is no longer here would wait for ids that may never come.
  if (afterId > newest) return { status: 200, body: { cursor: newest, rows: [], ...starts } }
  const rows = watchRows(db, { afterId, before: now - WATCH_SETTLE_MS, host, project, limit: WATCH_LIMIT })
  return { status: 200, body: { cursor: rows.at(-1)?.id ?? afterId, rows, ...starts } }
}

/** The session starts after `afterId` (null: from now) and the cursor to ask from next, which passes every row looked at, shown or not. */
function startsPart(db: Database, afterId: number | null, host: string | null, project: string | null, now: number): { startCursor: number; starts: WatchStart[] } {
  // Read first: a pack recorded while the rows are read is then left for the next ask.
  const latest = latestInjectionId(db)
  // A cursor past the newest row is from a store that was replaced (a restore, a switch back): start again from now.
  if (afterId === null || afterId > latest) return { startCursor: latest, starts: [] }
  const starts = watchStarts(db, { afterId, host, project, limit: WATCH_LIMIT, now }).filter((row) => row.id <= latest)
  return { startCursor: starts.length === WATCH_LIMIT ? (starts.at(-1)?.id ?? latest) : Math.max(latest, afterId), starts }
}
