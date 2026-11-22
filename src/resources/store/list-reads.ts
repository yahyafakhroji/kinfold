// The dashboard's lists, paged, sorted and filtered here so a browser never
// loads a whole table. Every sort column comes from a fixed map and every
// value is a bound parameter. Each list breaks ties on id, so a page never
// repeats or skips a row. Memory search takes an FTS5 MATCH expression the
// route built with src/controllers/mcp/fts.ts; text is never read for the list itself.

import type { Database } from '../sqlite/types'

export type SortDir = 'asc' | 'desc'

export interface PageQuery<S extends string> {
  page: number
  pageSize: number
  sort: S
  dir: SortDir
}

export interface Page<T> {
  rows: T[]
  total: number
}

type Bindings = Record<string, string | number | null>

const offset = (query: PageQuery<string>): number => (query.page - 1) * query.pageSize
const order = (column: string, dir: SortDir, tie: string): string => `${column} ${dir === 'asc' ? 'ASC' : 'DESC'}, ${tie}`

/** `q` as a LIKE pattern: its own % and _ match themselves. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`
}

// --- Sessions ---

export const SESSION_SORTS = { started: 's.started_at', project: 'project', agent: 's.host', device: 's.device', prompts: 'prompts' } as const
export type SessionSort = keyof typeof SESSION_SORTS

export interface SessionsQuery extends PageQuery<SessionSort> {
  q: string | null
  host: string | null
  project: string | null
  device: string | null
}

export interface SessionListRow {
  id: number
  startedAt: number
  lastEventAt: number
  endedAt: number | null
  host: string
  projectKey: string
  project: string
  /** 'local', a central device's id, or null where it was not recorded. */
  device: string | null
  prompts: number
  /** Prompts that were shown memory: a delivered prompt-time injection with ids. */
  promptsWithMemory: number
}

const SESSION_FROM = 'FROM sessions s LEFT JOIN projects p ON p.key = s.project_key'
const SESSION_WHERE = `WHERE ($host IS NULL OR s.host = $host) AND ($project IS NULL OR s.project_key = $project) AND ($device IS NULL OR s.device = $device)
  AND ($q IS NULL OR coalesce(p.display_name, s.project_key) LIKE $q ESCAPE '\\' OR s.cwd LIKE $q ESCAPE '\\')`
const SESSION_COLUMNS = `s.id, s.started_at AS startedAt, s.last_event_at AS lastEventAt, s.ended_at AS endedAt, s.host, s.project_key AS projectKey,
  coalesce(p.display_name, s.project_key) AS project, s.device, (SELECT count(*) FROM prompts WHERE session_id = s.id) AS prompts,
  (SELECT count(DISTINCT i.prompt_number) FROM injections i WHERE i.host = s.host AND i.host_session_id = s.host_session_id AND i.channel = 'prompt'
     AND i.late = 0 AND i.held_out = 0 AND i.prompt_number IS NOT NULL AND i.observation_ids <> '[]') AS promptsWithMemory`

function sessionBindings(query: SessionsQuery): Bindings {
  return { host: query.host, project: query.project, device: query.device, q: query.q === null ? null : likePattern(query.q) }
}

export function sessionsPage(db: Database, query: SessionsQuery): Page<SessionListRow> {
  const bindings = sessionBindings(query)
  const rows = db.query<SessionListRow, Bindings>(
    `SELECT ${SESSION_COLUMNS} ${SESSION_FROM} ${SESSION_WHERE} ORDER BY ${order(SESSION_SORTS[query.sort], query.dir, 's.started_at DESC, s.id DESC')} LIMIT $limit OFFSET $offset`,
  ).all({ ...bindings, limit: query.pageSize, offset: offset(query) })
  const total = db.query<{ n: number }, Bindings>(`SELECT count(*) AS n ${SESSION_FROM} ${SESSION_WHERE}`).get(bindings)?.n ?? 0
  return { rows, total }
}

export interface SessionHeader extends SessionListRow {
  cwd: string
  /** Memories in the pack the session got at its start; 0 when it got none. */
  startMemories: number
}

export function sessionHeader(db: Database, id: number): SessionHeader | null {
  return db.query<SessionHeader, { id: number }>(
    `SELECT ${SESSION_COLUMNS}, s.cwd,
       coalesce((SELECT json_array_length(i.observation_ids) FROM injections i WHERE i.host = s.host AND i.host_session_id = s.host_session_id
         AND i.channel IN ('session_start', 'request') ORDER BY i.id LIMIT 1), 0) AS startMemories
     ${SESSION_FROM} WHERE s.id = $id`,
  ).get({ id })
}

// --- Memories ---

export const MEMORY_SORTS = { age: 'o.occurred_at', title: 'o.title', project: 'project', kind: 'o.type', recalls: 'o.recall_count' } as const
export type MemorySort = keyof typeof MEMORY_SORTS

export interface MemoriesQuery extends PageQuery<MemorySort> {
  host: string | null
  project: string | null
  type: string | null
  device: string | null
  /** An FTS5 MATCH expression, or null for no search. */
  match: string | null
}

export interface MemoryListRow {
  id: number
  title: string
  type: string
  projectKey: string
  project: string
  host: string
  device: string | null
  sessionId: number | null
  occurredAt: number
  recallCount: number
  contradicted: boolean
}

const MEMORY_FROM = 'FROM observations o LEFT JOIN projects p ON p.key = o.project_key LEFT JOIN sessions s ON s.id = o.session_id'
const MEMORY_WHERE = `WHERE ($project IS NULL OR o.project_key = $project) AND ($host IS NULL OR o.host = $host) AND ($type IS NULL OR o.type = $type)
  AND ($match IS NULL OR o.id IN (SELECT rowid FROM observations_fts WHERE observations_fts MATCH $match))`
const DEVICE_CLAUSE = ' AND s.device = $device'

export function memoriesPage(db: Database, query: MemoriesQuery): Page<MemoryListRow> {
  const filters: Bindings = { project: query.project, host: query.host, type: query.type, match: query.match }
  const bindings: Bindings = query.device === null ? filters : { ...filters, device: query.device }
  const where = query.device === null ? MEMORY_WHERE : MEMORY_WHERE + DEVICE_CLAUSE
  const rows = db.query<Omit<MemoryListRow, 'contradicted'> & { contradicted: number }, Bindings>(
    `SELECT o.id, o.title, o.type, o.project_key AS projectKey, coalesce(p.display_name, o.project_key) AS project, o.host, s.device,
       o.session_id AS sessionId, o.occurred_at AS occurredAt, o.recall_count AS recallCount, o.contradicted_by IS NOT NULL AS contradicted
     ${MEMORY_FROM} ${where} ORDER BY ${order(MEMORY_SORTS[query.sort], query.dir, 'o.id DESC')} LIMIT $limit OFFSET $offset`,
  ).all({ ...bindings, limit: query.pageSize, offset: offset(query) })
  // The session join is needed only to filter by device; without one the count reads the observations index alone.
  const countFrom = query.device === null ? 'FROM observations o' : MEMORY_FROM
  const total = db.query<{ n: number }, Bindings>(`SELECT count(*) AS n ${countFrom} ${where}`).get(bindings)?.n ?? 0
  return { rows: rows.map((row) => ({ ...row, contradicted: row.contradicted !== 0 })), total }
}

// --- Projects and devices ---

export const PROJECT_SORTS = { name: 'name', memories: 'memories', sessions: 'sessions', active: 'lastActiveAt' } as const
export type ProjectSort = keyof typeof PROJECT_SORTS

export interface ProjectsQuery extends PageQuery<ProjectSort> {
  q: string | null
}

export interface ProjectRow {
  key: string
  name: string
  memories: number
  sessions: number
  lastActiveAt: number | null
}

const PROJECT_WHERE = "WHERE p.merged_into IS NULL AND ($q IS NULL OR p.display_name LIKE $q ESCAPE '\\' OR p.key LIKE $q ESCAPE '\\')"

/** Projects a key was merged into stand for it; the merged key is an alias, not a project. */
export function projectsPage(db: Database, query: ProjectsQuery): Page<ProjectRow> {
  const bindings: Bindings = { q: query.q === null ? null : likePattern(query.q) }
  const rows = db.query<ProjectRow, Bindings>(
    `SELECT p.key, p.display_name AS name,
       (SELECT count(*) FROM observations WHERE project_key = p.key) AS memories,
       (SELECT count(*) FROM sessions WHERE project_key = p.key) AS sessions,
       (SELECT max(last_event_at) FROM sessions WHERE project_key = p.key) AS lastActiveAt
     FROM projects p ${PROJECT_WHERE} ORDER BY ${order(PROJECT_SORTS[query.sort], query.dir, 'p.key ASC')} LIMIT $limit OFFSET $offset`,
  ).all({ ...bindings, limit: query.pageSize, offset: offset(query) })
  const total = db.query<{ n: number }, Bindings>(`SELECT count(*) AS n FROM projects p ${PROJECT_WHERE}`).get(bindings)?.n ?? 0
  return { rows, total }
}

export interface DeviceSeen {
  device: string
  sessions: number
  lastSeenAt: number
}

/** Every device the store recorded a session from, most recently seen first. */
export function devicesSeen(db: Database): DeviceSeen[] {
  return db.query<DeviceSeen, []>(
    'SELECT device, count(*) AS sessions, max(last_event_at) AS lastSeenAt FROM sessions WHERE device IS NOT NULL GROUP BY device ORDER BY lastSeenAt DESC, device',
  ).all()
}
