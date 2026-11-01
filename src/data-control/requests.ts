// Validation for the /data routes' bodies and queries. Hand-written, like the
// other routes: unknown keys are errors, so a typo in a purge body cannot
// widen or silently drop a selector. Errors name the field, never echo it.

import type { Parsed } from '../context/types'
import { isRecord } from '../contract/event'
import { RETENTION_TABLES, type DataSettingsChange, type RetentionTable } from '../store/data-settings-store'
import { FINDING_ACTIONS, type FindingAction, type FindingQuery } from '../store/findings-store'
import type { PurgeTarget } from '../store/purge-store'
import { RESOLVE_ACTIONS, type ResolveAction } from './resolve'

/** The targets a client may name; row targets are internal to resolve and retention. */
export type PublicPurgeTarget = Extract<PurgeTarget, { kind: 'observation' | 'session' | 'project' | 'host' | 'range' }>

export interface PurgeRequest {
  target: PublicPurgeTarget
  dryRun: boolean
}

export const MAX_RETENTION_DAYS = 36_500
export const DEFAULT_FINDINGS_LIMIT = 100
export const MAX_FINDINGS_LIMIT = 500
const PURGE_KEYS = new Set(['observation', 'session', 'project', 'host', 'before', 'after', 'dryRun'])
const MAX_NAME_CHARS = 512

const isPositiveId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_NAME_CHARS

/** Epoch ms, or an ISO 8601 string. */
export function parseTime(value: unknown, field: string): Parsed<number> {
  if (Number.isSafeInteger(value)) return { ok: true, value: value as number }
  const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(ms) ? { ok: true, value: ms } : { ok: false, error: `${field} must be epoch ms or an ISO 8601 time` }
}

function rangeTarget(body: Record<string, unknown>): Parsed<PublicPurgeTarget> {
  if (body.before === undefined) return { ok: false, error: 'a date range needs before (after is optional)' }
  const before = parseTime(body.before, 'before')
  if (!before.ok) return before
  if (body.after === undefined) return { ok: true, value: { kind: 'range', after: null, before: before.value } }
  const after = parseTime(body.after, 'after')
  if (!after.ok) return after
  if (after.value >= before.value) return { ok: false, error: 'after must be earlier than before' }
  return { ok: true, value: { kind: 'range', after: after.value, before: before.value } }
}

function purgeTarget(body: Record<string, unknown>): Parsed<PublicPurgeTarget> {
  const named = ['observation', 'session', 'project', 'host'].filter((key) => body[key] !== undefined)
  const ranged = body.before !== undefined || body.after !== undefined
  if (named.length + (ranged ? 1 : 0) !== 1) return { ok: false, error: 'name exactly one of observation, session, project, host, or a before/after range' }
  if (ranged) return rangeTarget(body)
  const key = named[0]!
  const value = body[key]
  if (key === 'observation' || key === 'session') {
    return isPositiveId(value) ? { ok: true, value: { kind: key, id: value } } : { ok: false, error: `${key} must be a positive integer id` }
  }
  if (!isName(value)) return { ok: false, error: `${key} must be a non-empty string` }
  return { ok: true, value: key === 'project' ? { kind: 'project', key: value } : { kind: 'host', host: value } }
}

export function parsePurgeBody(body: unknown): Parsed<PurgeRequest> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  const unknown = Object.keys(body).find((key) => !PURGE_KEYS.has(key))
  if (unknown !== undefined) return { ok: false, error: `unknown purge field ${JSON.stringify(unknown.slice(0, 40))}` }
  if (body.dryRun !== undefined && typeof body.dryRun !== 'boolean') return { ok: false, error: 'dryRun must be a boolean' }
  const target = purgeTarget(body)
  return target.ok ? { ok: true, value: { target: target.value, dryRun: body.dryRun === true } } : target
}

function parseDays(value: unknown, table: string): Parsed<number | null> {
  if (value === null) return { ok: true, value: null }
  if (Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= MAX_RETENTION_DAYS) return { ok: true, value: value as number }
  return { ok: false, error: `retention.${table} must be whole days from 1 to ${MAX_RETENTION_DAYS}, or null to keep forever` }
}

function parseRetentionDays(value: unknown): Parsed<Partial<Record<RetentionTable, number | null>>> {
  if (!isRecord(value)) return { ok: false, error: 'retention must be an object of table: days' }
  const out: Partial<Record<RetentionTable, number | null>> = {}
  for (const [table, days] of Object.entries(value)) {
    if (!RETENTION_TABLES.includes(table as RetentionTable)) return { ok: false, error: `retention tables are ${RETENTION_TABLES.join(', ')}` }
    const parsed = parseDays(days, table)
    if (!parsed.ok) return parsed
    out[table as RetentionTable] = parsed.value
  }
  return { ok: true, value: out }
}

export function parseRetentionPut(body: unknown): Parsed<DataSettingsChange> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  if (Object.keys(body).some((key) => key !== 'retention' && key !== 'warnBytes')) return { ok: false, error: 'body takes retention and warnBytes only' }
  if (body.warnBytes !== undefined && !isPositiveId(body.warnBytes)) return { ok: false, error: 'warnBytes must be a positive integer' }
  const retention = body.retention === undefined ? null : parseRetentionDays(body.retention)
  if (retention !== null && !retention.ok) return retention
  return {
    ok: true,
    value: { ...(retention !== null ? { retention: retention.value } : {}), ...(body.warnBytes !== undefined ? { warnBytes: body.warnBytes as number } : {}) },
  }
}

export interface RetentionRequest {
  change: DataSettingsChange
  /** True: count what the change would expire now, save nothing. */
  preview: boolean
}

/** The PUT /data/retention body: the change, plus an optional `preview: true`. */
export function parseRetentionRequest(body: unknown): Parsed<RetentionRequest> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  if (body.preview !== undefined && typeof body.preview !== 'boolean') return { ok: false, error: 'preview must be a boolean' }
  const { preview, ...rest } = body
  const change = parseRetentionPut(rest)
  return change.ok ? { ok: true, value: { change: change.value, preview: preview === true } } : change
}

export function parseResolveBody(body: unknown): Parsed<ResolveAction> {
  if (!isRecord(body) || !RESOLVE_ACTIONS.includes(body.action as ResolveAction)) return { ok: false, error: `action must be one of ${RESOLVE_ACTIONS.join(', ')}` }
  return { ok: true, value: body.action as ResolveAction }
}

/** ?action=pending (default) | redacted | purged | expired | all, ?limit=1..500. */
export function parseFindingsQuery(params: URLSearchParams): Parsed<FindingQuery> {
  const action = params.get('action') ?? 'pending'
  if (action !== 'all' && !FINDING_ACTIONS.includes(action as FindingAction)) return { ok: false, error: `action must be all or one of ${FINDING_ACTIONS.join(', ')}` }
  const limitText = params.get('limit')
  const limit = limitText === null ? DEFAULT_FINDINGS_LIMIT : Number(limitText)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_FINDINGS_LIMIT) return { ok: false, error: `limit must be 1 to ${MAX_FINDINGS_LIMIT}` }
  return { ok: true, value: { action: action === 'all' ? null : (action as FindingAction), limit } }
}
