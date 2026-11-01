// The memory browser's read routes: GET /memory/observations (filters,
// search, pages), GET /memory/observations/:id and GET /memory/facets. Search
// text goes through the MCP server's sanitizer (src/mcp/fts.ts), so the
// dashboard and agents share one rule for what reaches FTS5 MATCH. Answers
// hold observations only, never an event payload. Errors name the parameter,
// never echo it, and the log line holds counts and the duration.

import type { Parsed } from '../context/types'
import { EVIDENCE_FILTERS } from '../mcp/args'
import { ftsMatch, parseSearchQuery } from '../mcp/fts'
import type { IndexRow } from '../mcp/reader'
import { OBSERVATION_TYPES, type ObservationType } from '../observer/types'
import type { Database } from '../sqlite/types'
import { type BrowseFilters, type Facets, type ObservationDetail, browseObservations, observationDetail, observationFacets } from '../store/memory-reads'
import type { RouteAnswer } from './data-routes'

export const PAGE_SIZE = 50
export const MAX_PAGE = 1_000
const HOST_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const MAX_PROJECT_CHARS = 512
const QUERY_KEYS = new Set(['project', 'host', 'type', 'evidence', 'q', 'page'])
const DETAIL_PATH = /^\/memory\/observations\/(\d{1,15})$/

export interface BrowseQuery {
  filters: BrowseFilters
  page: number
}

export interface BrowseAnswer {
  rows: IndexRow[]
  total: number
  page: number
  pageSize: number
  hasMore: boolean
}

export interface MemoryHandlers {
  browse: (query: BrowseQuery) => BrowseAnswer
  detail: (id: number) => ObservationDetail | null
  facets: () => Facets
}

/** An empty value is the same as an absent one: a cleared filter in the page's form. */
function optional(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)
  return value === null || value.trim() === '' ? null : value.trim()
}

function parsePage(value: string | null): Parsed<number> {
  if (value === null) return { ok: true, value: 1 }
  const page = Number(value)
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE ? { ok: true, value: page } : { ok: false, error: `page must be an integer from 1 to ${MAX_PAGE}` }
}

function parseMatch(q: string | null): Parsed<string | null> {
  if (q === null) return { ok: true, value: null }
  const parsed = parseSearchQuery(q)
  return parsed.ok ? { ok: true, value: ftsMatch(parsed.terms, 'all') } : { ok: false, error: `q: ${parsed.error}` }
}

function checkFilters(project: string | null, host: string | null, type: string | null, evidence: string | null): string | null {
  if (project !== null && project.length > MAX_PROJECT_CHARS) return 'project is too long'
  if (host !== null && !HOST_PATTERN.test(host)) return 'host must be a short lowercase name'
  if (type !== null && !OBSERVATION_TYPES.includes(type as ObservationType)) return `type must be one of ${OBSERVATION_TYPES.join(', ')}`
  if (evidence !== null && !(EVIDENCE_FILTERS as readonly string[]).includes(evidence)) return `evidence must be one of ${EVIDENCE_FILTERS.join(', ')}`
  return null
}

export function parseBrowseQuery(params: URLSearchParams): Parsed<BrowseQuery> {
  const unknown = [...params.keys()].find((key) => !QUERY_KEYS.has(key))
  if (unknown !== undefined) return { ok: false, error: 'unknown query parameter' }
  const [project, host, type, evidence] = ['project', 'host', 'type', 'evidence'].map((name) => optional(params, name))
  const problem = checkFilters(project ?? null, host ?? null, type ?? null, evidence ?? null)
  if (problem !== null) return { ok: false, error: problem }
  const page = parsePage(optional(params, 'page'))
  if (!page.ok) return page
  const match = parseMatch(optional(params, 'q'))
  if (!match.ok) return match
  const filters: BrowseFilters = {
    project: project ?? null, host: host ?? null, type: type ?? null, evidence: evidence ?? null,
    match: match.value, limit: PAGE_SIZE, offset: (page.value - 1) * PAGE_SIZE,
  }
  return { ok: true, value: { filters, page: page.value } }
}

export function memoryHandlers(db: Database, log: (line: string) => void): MemoryHandlers {
  return {
    browse: (query) => {
      const startedAt = performance.now()
      const result = browseObservations(db, query.filters)
      log(`memory browse rows=${result.rows.length} total=${result.total} search=${query.filters.match !== null} ms=${Math.round(performance.now() - startedAt)}`)
      return { ...result, page: query.page, pageSize: PAGE_SIZE, hasMore: query.filters.offset + result.rows.length < result.total }
    },
    detail: (id) => observationDetail(db, id),
    facets: () => observationFacets(db),
  }
}

/** Null when the path is not a /memory route, so the caller answers 404. */
export function memoryRoute(method: string, url: URL, handlers: MemoryHandlers): RouteAnswer | null {
  const path = url.pathname
  const detail = DETAIL_PATH.exec(path)
  if (path !== '/memory/observations' && path !== '/memory/facets' && detail === null) return null
  if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
  if (path === '/memory/facets') return { status: 200, body: handlers.facets() }
  if (detail !== null) {
    const found = handlers.detail(Number(detail[1]))
    return found === null ? { status: 404, body: { error: 'no such observation' } } : { status: 200, body: found }
  }
  const query = parseBrowseQuery(url.searchParams)
  return query.ok ? { status: 200, body: handlers.browse(query.value) } : { status: 400, body: { error: query.error } }
}
