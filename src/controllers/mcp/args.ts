// Validates the arguments an agent passes to each MCP tool. Errors name the
// argument and never echo its value (the query text is the user's words).
// Counts over their cap are clamped rather than refused, since an agent
// asking for 50 results still wants an answer; ids over the cap are refused,
// because silently dropping some would read as "not found".

import { isRecord } from '../contract/event'

export const SEARCH_LIMIT_MAX = 20
export const SEARCH_LIMIT_DEFAULT = 10
export const SEARCH_OFFSET_MAX = 1000
export const TIMELINE_DEPTH_MAX = 10
export const TIMELINE_DEPTH_DEFAULT = 3
export const IDS_MAX = 20
export const EVIDENCE_FILTERS = ['tool-verified', 'interpretation', 'user-stated', 'contradicted'] as const
/** `project: "*"` widens a tool to every project. */
export const ALL_PROJECTS = '*'

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_PROJECT_CHARS = 4096

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

/** Absent: the server's own project. `"*"`: every project. */
export type ProjectArg = { kind: 'default' } | { kind: 'all' } | { kind: 'key'; key: string }

export interface SearchArgs {
  project: ProjectArg
  query: string
  type: string | null
  host: string | null
  evidence: string | null
  limit: number
  offset: number
}

export type TimelineTarget = { kind: 'anchor'; id: number } | { kind: 'session'; id: number }

export interface TimelineArgs {
  project: ProjectArg
  target: TimelineTarget
  before: number
  after: number
}

export interface GetObservationsArgs {
  project: ProjectArg
  ids: number[]
}

type Field<T> = Parsed<T>

const ok = <T>(value: T): Field<T> => ({ ok: true, value })
const fail = <T>(error: string): Field<T> => ({ ok: false, error })

function projectArg(value: unknown): Field<ProjectArg> {
  if (value === undefined) return ok({ kind: 'default' })
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_PROJECT_CHARS) {
    return fail('project must be a project key or "*"')
  }
  return ok(value === ALL_PROJECTS ? { kind: 'all' } : { kind: 'key', key: value })
}

function optionalName(value: unknown, name: string): Field<string | null> {
  if (value === undefined || value === null) return ok(null)
  return typeof value === 'string' && NAME_PATTERN.test(value) ? ok(value) : fail(`${name} must be a short lowercase name`)
}

/** An integer in [min, ∞), clamped to max; the default when absent. */
function clampedInt(value: unknown, name: string, min: number, max: number, fallback: number): Field<number> {
  if (value === undefined || value === null) return ok(fallback)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) return fail(`${name} must be an integer of at least ${min}`)
  return ok(Math.min(value, max))
}

function positiveId(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function argsObject(args: unknown): Field<Record<string, unknown>> {
  if (args === undefined || args === null) return ok({})
  return isRecord(args) ? ok(args) : fail('arguments must be an object')
}

/** The first failed field, or every value. */
function collect<T extends object>(fields: { [K in keyof T]: Field<T[K]> }): Parsed<T> {
  const entries = Object.entries(fields) as [keyof T, Field<unknown>][]
  const failed = entries.find(([, field]) => !field.ok)
  if (failed !== undefined) return failed[1] as { ok: false; error: string }
  return ok(Object.fromEntries(entries.map(([key, field]) => [key, (field as { value: unknown }).value])) as T)
}

export function parseSearchArgs(raw: unknown): Parsed<SearchArgs> {
  const args = argsObject(raw)
  if (!args.ok) return args
  const { query, evidence } = args.value
  if (typeof query !== 'string') return fail('query is required and must be a string')
  const evidenceField: Field<string | null> = evidence === undefined || evidence === null
    ? ok(null)
    : EVIDENCE_FILTERS.includes(evidence as (typeof EVIDENCE_FILTERS)[number])
      ? ok(evidence as string)
      : fail(`evidence must be one of ${EVIDENCE_FILTERS.join(', ')}`)
  return collect<SearchArgs>({
    project: projectArg(args.value.project),
    query: ok(query),
    type: optionalName(args.value.type, 'type'),
    host: optionalName(args.value.host, 'host'),
    evidence: evidenceField,
    limit: clampedInt(args.value.limit, 'limit', 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_DEFAULT),
    offset: clampedInt(args.value.offset, 'offset', 0, SEARCH_OFFSET_MAX, 0),
  })
}

function timelineTarget(anchorId: unknown, sessionId: unknown): Field<TimelineTarget> {
  const hasAnchor = anchorId !== undefined && anchorId !== null
  const hasSession = sessionId !== undefined && sessionId !== null
  if (hasAnchor === hasSession) return fail('pass exactly one of anchorId or sessionId')
  if (hasAnchor) return positiveId(anchorId) ? ok({ kind: 'anchor', id: anchorId as number }) : fail('anchorId must be a positive integer')
  return positiveId(sessionId) ? ok({ kind: 'session', id: sessionId as number }) : fail('sessionId must be a positive integer')
}

export function parseTimelineArgs(raw: unknown): Parsed<TimelineArgs> {
  const args = argsObject(raw)
  if (!args.ok) return args
  return collect<TimelineArgs>({
    project: projectArg(args.value.project),
    target: timelineTarget(args.value.anchorId, args.value.sessionId),
    before: clampedInt(args.value.before, 'before', 0, TIMELINE_DEPTH_MAX, TIMELINE_DEPTH_DEFAULT),
    after: clampedInt(args.value.after, 'after', 0, TIMELINE_DEPTH_MAX, TIMELINE_DEPTH_DEFAULT),
  })
}

export function parseGetObservationsArgs(raw: unknown): Parsed<GetObservationsArgs> {
  const args = argsObject(raw)
  if (!args.ok) return args
  const { ids } = args.value
  if (!Array.isArray(ids) || ids.length === 0) return fail('ids must be a non-empty list of observation ids')
  if (ids.length > IDS_MAX) return fail(`ids must hold at most ${IDS_MAX} ids; fetch the rest in another call`)
  if (!ids.every(positiveId)) return fail('every id must be a positive integer')
  return collect<GetObservationsArgs>({ project: projectArg(args.value.project), ids: ok([...new Set(ids as number[])]) })
}
