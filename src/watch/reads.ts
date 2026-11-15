// What `kinfold watch` shows, read from the store: one row per prompt, with
// the memory the prompt channel sent for it. A prompt is the unit rather than
// an injection because an answer that carried nothing records no injection,
// and the user still wants to see that the prompt was seen. Rows hold ids,
// titles, an agent and a project name; never prompt or reply text.

import { HELD_OUT_LINE, type Recalled, recallLine } from '../context/recall-line'
import type { RouteAnswer } from '../daemon/data-routes'
import type { Database } from '../sqlite/types'
import { titlesFor } from '../store/context-store'

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
    `SELECT observation_ids AS ids, held_out AS heldOut, related_count AS relatedCount FROM injections
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
    return {
      id: prompt.id, at: prompt.at, host: prompt.host, project: prompt.project, ids, recalled, heldOut,
      hostSessionId: prompt.hostSessionId, promptNumber: prompt.promptNumber,
      line: heldOut ? HELD_OUT_LINE : recallLine(ids, recalled),
    }
  })
}

const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_PROJECT_CHARS = 300

/**
 * GET /watch[?after=<id>][&host=][&project=] (token only). Without `after` it
 * answers the current cursor and no rows, so a watcher starts from now; with
 * it, the settled prompts after that id and the cursor to ask from next.
 */
export function watchRoute(db: Database, method: string, url: URL, now: number): RouteAnswer {
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
  const after = url.searchParams.get('after')
  const host = url.searchParams.get('host')
  const project = url.searchParams.get('project')
  if (after !== null && !/^\d{1,15}$/.test(after)) return { status: 400, body: { error: 'after must be a prompt id' } }
  if (host !== null && !HOST_PATTERN.test(host)) return { status: 400, body: { error: 'host must be an agent id' } }
  if (project !== null && (project === '' || project.length > MAX_PROJECT_CHARS)) return { status: 400, body: { error: 'project must be a name or key' } }
  if (after === null) return { status: 200, body: { cursor: latestPromptId(db), rows: [] } }
  const afterId = Number(after)
  const rows = watchRows(db, { afterId, before: now - WATCH_SETTLE_MS, host, project, limit: WATCH_LIMIT })
  return { status: 200, body: { cursor: rows.at(-1)?.id ?? afterId, rows } }
}
