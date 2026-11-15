// Reads for the dashboard's Sessions view: the list of sessions, and one
// session's turns in order. A turn is a prompt with what happened around it:
// the memory recalled for it (the prompt-time injections stamped with its
// number), the agent's reply (prompts.reply_text), and what the observer saved
// from it (observations and the summary), which the page shows as side detail.
// Prompt and reply are returned as stored, which is after the secret scan, so
// a secret is its redaction marker. Both lists are paged by a cursor.

import type { Recalled } from '../context/recall-line'
import type { Database } from '../sqlite/types'
import { titlesFor } from './context-store'
import { readDisplaySettings } from './display-settings'

export const SESSIONS_PAGE = 30
export const TURNS_PAGE = 20

export interface SessionRow {
  id: number
  host: string
  projectKey: string
  /** The project's display name. */
  project: string
  startedAt: number
  lastEventAt: number
  endedAt: number | null
  prompts: number
}

export interface SessionQuery {
  host: string | null
  /** A project key. */
  project: string | null
  /** Only sessions with an id below this: the previous page's `nextBefore`. */
  before: number | null
  limit: number
}

export interface SessionList {
  sessions: SessionRow[]
  /** The cursor for the next page; null when this was the last. */
  nextBefore: number | null
}

const SESSION_COLUMNS = `s.id, s.host, s.project_key AS projectKey, coalesce(p.display_name, s.project_key) AS project, s.started_at AS startedAt,
  s.last_event_at AS lastEventAt, s.ended_at AS endedAt, (SELECT count(*) FROM prompts WHERE session_id = s.id) AS prompts`

/** Newest first. Session ids rise with first sight, so the id is the cursor and the order. */
export function listSessions(db: Database, query: SessionQuery): SessionList {
  const rows = db.query<SessionRow, Record<string, string | number | null>>(
    `SELECT ${SESSION_COLUMNS} FROM sessions s LEFT JOIN projects p ON p.key = s.project_key
     WHERE ($host IS NULL OR s.host = $host) AND ($project IS NULL OR s.project_key = $project) AND ($before IS NULL OR s.id < $before)
     ORDER BY s.id DESC LIMIT $limit`,
  ).all({ host: query.host, project: query.project, before: query.before, limit: query.limit + 1 })
  const sessions = rows.slice(0, query.limit)
  return { sessions, nextBefore: rows.length > query.limit ? (sessions.at(-1)?.id ?? null) : null }
}

export interface SavedObservation {
  id: number
  title: string
  type: string
}

export interface TurnSummary {
  request: string | null
  learned: string | null
  completed: string | null
  nextSteps: string | null
}

export interface SessionTurn {
  promptNumber: number
  at: number
  prompt: string
  /** Null when no reply was captured for the turn. */
  reply: string | null
  /** Retention replaced the text with its marker. */
  expired: boolean
  recalled: Recalled[]
  /**
   * False for a turn from before this store tied recall to prompts (schema
   * v12): what was recalled for it is not known, which is not the same as
   * nothing.
   */
  recallKnown: boolean
  /** The impact test held recall back for this prompt. */
  heldOut: boolean
  saved: SavedObservation[]
  summary: TurnSummary | null
}

export interface SessionDetail {
  session: SessionRow & {
    /** Memories in the pack the session got at its start (or OpenCode's per-session pack); 0 when it got none. */
    startMemories: number
  }
  turns: SessionTurn[]
  /** The prompt number to ask from for the next page; null when this was the last. */
  nextAfter: number | null
}

interface PromptRow {
  promptNumber: number
  at: number
  prompt: string
  reply: string | null
  expiredAt: number | null
  summaryId: number | null
}

function parseIds(json: string): number[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)) : []
  } catch {
    return []
  }
}

/** One page of a session's turns after prompt `after`; null for a session that does not exist. */
export function sessionTurns(db: Database, sessionId: number, after: number, limit: number): SessionDetail | null {
  const session = db.query<SessionRow & { hostSessionId: string }, { sessionId: number }>(
    `SELECT ${SESSION_COLUMNS}, s.host_session_id AS hostSessionId FROM sessions s LEFT JOIN projects p ON p.key = s.project_key WHERE s.id = $sessionId`,
  ).get({ sessionId })
  if (session === null) return null
  const { hostSessionId, ...row } = session
  const prompts = db.query<PromptRow, { sessionId: number; after: number; limit: number }>(
    `SELECT prompt_number AS promptNumber, occurred_at AS at, text AS prompt, reply_text AS reply, text_expired_at AS expiredAt, summary_id AS summaryId
     FROM prompts WHERE session_id = $sessionId AND prompt_number > $after ORDER BY prompt_number LIMIT $limit`,
  ).all({ sessionId, after, limit: limit + 1 })
  const page = prompts.slice(0, limit)

  const sent = db.query<{ ids: string; heldOut: number; relatedCount: number }, { host: string; hostSessionId: string; promptNumber: number }>(
    `SELECT observation_ids AS ids, held_out AS heldOut, related_count AS relatedCount FROM injections
     WHERE host = $host AND host_session_id = $hostSessionId AND channel = 'prompt' AND prompt_number = $promptNumber ORDER BY id`,
  )
  const saved = db.query<SavedObservation, { sessionId: number; promptNumber: number }>(
    'SELECT id, title, type FROM observations WHERE session_id = $sessionId AND prompt_number = $promptNumber ORDER BY id',
  )
  const summary = db.query<TurnSummary, { id: number }>('SELECT request, learned, completed, next_steps AS nextSteps FROM summaries WHERE id = $id')
  const start = db.query<{ ids: string }, { host: string; hostSessionId: string }>(
    `SELECT observation_ids AS ids FROM injections WHERE host = $host AND host_session_id = $hostSessionId AND channel IN ('session_start', 'request')
     ORDER BY id LIMIT 1`,
  ).get({ host: row.host, hostSessionId })

  const { since } = readDisplaySettings(db)
  const turns = page.map((prompt): SessionTurn => {
    const injections = sent.all({ host: row.host, hostSessionId, promptNumber: prompt.promptNumber })
    // In each row the related ids are the last ones (the delta comes first).
    const parts = injections.flatMap((injection) => {
      const ids = parseIds(injection.ids)
      return ids.map((id, index) => ({ id, part: index >= ids.length - injection.relatedCount ? 'related' as const : 'new' as const }))
    })
    const titles = titlesFor(db, parts.map((entry) => entry.id))
    return {
      promptNumber: prompt.promptNumber, at: prompt.at, prompt: prompt.prompt, reply: prompt.reply, expired: prompt.expiredAt !== null,
      heldOut: injections.some((injection) => injection.heldOut !== 0),
      recallKnown: injections.length > 0 || since === null || prompt.at >= since,
      recalled: parts.map((entry) => ({ id: entry.id, title: titles.get(entry.id) ?? '', part: entry.part })),
      saved: saved.all({ sessionId, promptNumber: prompt.promptNumber }),
      summary: prompt.summaryId === null ? null : summary.get({ id: prompt.summaryId }),
    }
  })
  return {
    session: { ...row, startMemories: start === null ? 0 : parseIds(start.ids).length },
    turns,
    nextAfter: prompts.length > limit ? (page.at(-1)?.promptNumber ?? null) : null,
  }
}
