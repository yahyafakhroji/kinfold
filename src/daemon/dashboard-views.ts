// The new dashboard's views, all GET under /memory/ so they take the token or
// the dashboard cookie like the rest of /memory/, and a central device relays
// them to its hub through the /memory/ prefix of the hub's allowlist
// (src/central/hub-routes.ts):
//   /memory/list/sessions, /memory/list/memories, /memory/list/activity,
//   /memory/list/projects, /memory/list/devices: pages of 50, sorted and
//     filtered on the reports reader, so the daemon's own thread never scans.
//   /memory/sessions/:id: one session's header with its saved box.
//   /memory/overview, /memory/impact?window=7d|30d: kept reports with their
//     as-of time (src/dashboard/kept-report.ts).
// Answers hold titles, names and counts; errors name the parameter.

import { type KeptReport, keptReport } from '../dashboard/kept-report'
import { IMPACT_WINDOWS, type ImpactReport, type ImpactWindow, type MeasuredEntries, type OverviewReport, sessionHeaderWithSaved } from '../dashboard/overview'
import { ftsMatch, parseSearchQuery } from '../mcp/fts'
import { OBSERVATION_TYPES, type ObservationType } from '../observer/types'
import type { Database } from '../sqlite/types'
import { ACTIVITY_KINDS, type ActivityKind, isActivityKind } from '../store/activity-store'
import { MEMORY_SORTS, PROJECT_SORTS, SESSION_SORTS } from '../store/list-reads'
import type { StoreReader } from '../workers/store-reader'
import type { RouteAnswer } from './data-routes'
import { FILTERS, type ListParams, LIST_PAGE_SIZE, parseListParams } from './list-params'

/** How old each kept report may be before a page ask refreshes it behind the answer. */
export const MEASURED_MAX_AGE_MS = 10 * 60_000
export const OVERVIEW_MAX_AGE_MS = 2 * 60_000
export const IMPACT_MAX_AGE_MS = 5 * 60_000

const SESSION_HEADER = /^\/memory\/sessions\/(\d{1,15})$/

export interface DashboardViewOptions {
  /** Paired device names by id, on a hub; empty elsewhere. */
  deviceNames?: () => ReadonlyMap<string, string>
  now?: () => number
  log?: (line: string) => void
}

const bad = (error: string): RouteAnswer => ({ status: 400, body: { error } })
const ok = (body: unknown): RouteAnswer => ({ status: 200, body })
const paging = <S extends string, F extends string>(params: ListParams<S, F>) => ({ page: params.page, pageSize: params.pageSize, sort: params.sort, dir: params.dir })

const typeCheck = (value: string): string | null => (OBSERVATION_TYPES.includes(value as ObservationType) ? null : `type must be one of ${OBSERVATION_TYPES.join(', ')}`)
const kindCheck = (value: string): string | null => (value.split(',').every(isActivityKind) ? null : `kind must be one or more of ${ACTIVITY_KINDS.join(', ')}`)

export type ViewRoute = ((method: string, url: URL) => Promise<RouteAnswer | null>) & {
  /** Computes the kept reports now, so the first page that asks finds them ready; failures are logged. */
  warm: () => Promise<void>
  /** After rows were removed (a purge, a retention run): the next ask of each kept report computes it again, so the pages do not show counts from before. */
  invalidate: () => void
}

export function dashboardViews(db: Database, reports: StoreReader, options: DashboardViewOptions = {}): ViewRoute {
  const now = options.now ?? Date.now
  const onError = (error: unknown): void => options.log?.(`dashboard report refresh failed: ${error instanceof Error ? error.name : 'error'}`)
  const measured = keptReport<MeasuredEntries>(() => reports.run('measuredSaving', {}), { maxAgeMs: MEASURED_MAX_AGE_MS, now, onError })
  const measuredNow = async (): Promise<MeasuredEntries> => (await measured.get()).value
  const overview = keptReport<OverviewReport>(async () => reports.run('overviewReport', { now: now(), measured: await measuredNow() }), { maxAgeMs: OVERVIEW_MAX_AGE_MS, now, onError })
  const impact = new Map<ImpactWindow, KeptReport<ImpactReport>>((Object.keys(IMPACT_WINDOWS) as ImpactWindow[]).map((window) => [
    window,
    keptReport(async () => reports.run('impactReport', { now: now(), window, measured: await measuredNow() }), { maxAgeMs: IMPACT_MAX_AGE_MS, now, onError }),
  ]))

  const sessions = async (params: URLSearchParams): Promise<RouteAnswer> => {
    const parsed = parseListParams(params, { sorts: Object.keys(SESSION_SORTS) as (keyof typeof SESSION_SORTS)[], sort: 'started', dir: 'desc', filters: FILTERS })
    if (!parsed.ok) return bad(parsed.error)
    const { filters } = parsed.value
    const query = { ...paging(parsed.value), q: filters.q, host: filters.host, project: filters.project, device: filters.device }
    return ok({ ...(await reports.run('dashboardSessions', { query, measured: await measuredNow() })), ...paging(parsed.value) })
  }
  const memories = async (params: URLSearchParams): Promise<RouteAnswer> => {
    const parsed = parseListParams(params, { sorts: Object.keys(MEMORY_SORTS) as (keyof typeof MEMORY_SORTS)[], sort: 'age', dir: 'desc', filters: { ...FILTERS, type: typeCheck } })
    if (!parsed.ok) return bad(parsed.error)
    const { filters } = parsed.value
    let match: string | null = null
    if (filters.q !== null) {
      const search = parseSearchQuery(filters.q)
      if (!search.ok) return bad(`q: ${search.error}`)
      match = ftsMatch(search.terms, 'all')
    }
    const query = { ...paging(parsed.value), host: filters.host, project: filters.project, device: filters.device, type: filters.type, match }
    return ok({ ...(await reports.run('dashboardMemories', { query })), ...paging(parsed.value) })
  }
  const activity = async (params: URLSearchParams): Promise<RouteAnswer> => {
    const parsed = parseListParams(params, { sorts: ['time'] as const, sort: 'time', dir: 'desc', filters: { kind: kindCheck } })
    if (!parsed.ok) return bad(parsed.error)
    // Activity reads newest first only, so an answer never claims an order it did not use.
    if (parsed.value.dir !== 'desc') return bad('dir must be desc for activity')
    const kinds = parsed.value.filters.kind === null ? null : (parsed.value.filters.kind.split(',') as ActivityKind[])
    const page = await reports.run('dashboardActivity', { query: { kinds, limit: LIST_PAGE_SIZE, offset: (parsed.value.page - 1) * LIST_PAGE_SIZE } })
    return ok({ ...page, ...paging(parsed.value) })
  }
  const projects = async (params: URLSearchParams): Promise<RouteAnswer> => {
    const parsed = parseListParams(params, { sorts: Object.keys(PROJECT_SORTS) as (keyof typeof PROJECT_SORTS)[], sort: 'active', dir: 'desc', filters: { q: FILTERS.q } })
    if (!parsed.ok) return bad(parsed.error)
    return ok({ ...(await reports.run('dashboardProjects', { query: { ...paging(parsed.value), q: parsed.value.filters.q } })), ...paging(parsed.value) })
  }
  const devices = async (params: URLSearchParams): Promise<RouteAnswer> => {
    if ([...params.keys()].length > 0) return bad('unknown query parameter')
    const names = options.deviceNames?.() ?? new Map<string, string>()
    const seen = await reports.run('dashboardDevices', {})
    const unseen = [...names.keys()].filter((id) => !seen.some((row) => row.device === id))
    const rows = [...seen.map((row) => ({ ...row, name: names.get(row.device) ?? null })), ...unseen.map((device) => ({ device, name: names.get(device) ?? null, sessions: 0, lastSeenAt: null }))]
    return ok({ rows })
  }
  const lists: Record<string, (params: URLSearchParams) => Promise<RouteAnswer>> = {
    '/memory/list/sessions': sessions, '/memory/list/memories': memories, '/memory/list/activity': activity, '/memory/list/projects': projects, '/memory/list/devices': devices,
  }

  const route = async (method: string, url: URL): Promise<RouteAnswer | null> => {
    const path = url.pathname
    const list = lists[path]
    const header = SESSION_HEADER.exec(path)
    const report = path === '/memory/overview' || path === '/memory/impact'
    if (list === undefined && header === null && !report) return null
    if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
    if (list !== undefined) return list(url.searchParams)
    if (header !== null) {
      const found = sessionHeaderWithSaved(db, Number(header[1]), await measuredNow())
      return found === null ? { status: 404, body: { error: 'no such session' } } : ok(found)
    }
    if (path === '/memory/overview') return [...url.searchParams.keys()].length > 0 ? bad('unknown query parameter') : ok(await overview.get())
    if ([...url.searchParams.keys()].some((key) => key !== 'window')) return bad('unknown query parameter')
    const window = (url.searchParams.get('window') ?? '7d') as ImpactWindow
    const kept = impact.get(window)
    return kept === undefined ? bad(`window must be one of ${Object.keys(IMPACT_WINDOWS).join(', ')}`) : ok(await kept.get())
  }
  const warm = async (): Promise<void> => {
    try {
      await Promise.all([overview.get(), ...[...impact.values()].map((kept) => kept.get())])
    } catch (error: unknown) {
      options.log?.(`dashboard report warm-up failed: ${error instanceof Error ? error.name : 'error'}`)
    }
  }
  const invalidate = (): void => {
    for (const kept of [measured, overview, ...impact.values()]) kept.invalidate()
  }
  return Object.assign(route, { warm, invalidate })
}
