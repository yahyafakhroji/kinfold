// Query parameters every dashboard list takes: page (1-based, pages of
// LIST_PAGE_SIZE), sort (one of the list's columns), dir and its own filters.
// An unknown parameter, sort or filter value is refused, and the error names
// the parameter without echoing what was sent.

import type { Parsed } from '../context/types'
import { HOST_NAME_PATTERN } from '../names'
import type { SortDir } from '../store/list-reads'

export const LIST_PAGE_SIZE = 50
export const MAX_LIST_PAGE = 10_000
export const MAX_QUERY_CHARS = 200
export const HOST_PATTERN = HOST_NAME_PATTERN
/** The longest project name or key a filter of the memory and session lists takes. */
export const MAX_PROJECT_CHARS = 512
export const DEVICE_PATTERN = /^(local|dev-[A-Za-z0-9_-]{1,64})$/
const MAX_KEY_CHARS = 4_200

export type FilterCheck = (value: string) => string | null

export const FILTERS = {
  host: (value: string) => (HOST_PATTERN.test(value) ? null : 'host must be a short lowercase name'),
  project: (value: string) => (value.length <= MAX_KEY_CHARS ? null : 'project is too long'),
  device: (value: string) => (DEVICE_PATTERN.test(value) ? null : 'device must be local or a device id'),
  q: (value: string) => (value.length <= MAX_QUERY_CHARS ? null : `q must be at most ${MAX_QUERY_CHARS} characters`),
} satisfies Record<string, FilterCheck>

export interface ListSpec<S extends string, F extends string> {
  sorts: readonly S[]
  sort: S
  dir: SortDir
  filters: Readonly<Record<F, FilterCheck>>
}

export interface ListParams<S extends string, F extends string> {
  page: number
  pageSize: number
  sort: S
  dir: SortDir
  filters: Record<F, string | null>
}

/** An empty value is the same as an absent one: a cleared filter in the page's form. */
export function optional(params: URLSearchParams, name: string): string | null {
  const value = params.get(name)
  return value === null || value.trim() === '' ? null : value.trim()
}

export function parseListParams<S extends string, F extends string>(params: URLSearchParams, spec: ListSpec<S, F>): Parsed<ListParams<S, F>> {
  const names = Object.keys(spec.filters) as F[]
  const known = new Set<string>(['page', 'sort', 'dir', ...names])
  if ([...params.keys()].some((key) => !known.has(key))) return { ok: false, error: 'unknown query parameter' }
  const pageText = optional(params, 'page')
  const page = pageText === null ? 1 : Number(pageText)
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_LIST_PAGE) return { ok: false, error: `page must be an integer from 1 to ${MAX_LIST_PAGE}` }
  const sort = optional(params, 'sort') ?? spec.sort
  if (!(spec.sorts as readonly string[]).includes(sort)) return { ok: false, error: `sort must be one of ${spec.sorts.join(', ')}` }
  const dir = optional(params, 'dir') ?? spec.dir
  if (dir !== 'asc' && dir !== 'desc') return { ok: false, error: 'dir must be asc or desc' }
  const filters = {} as Record<F, string | null>
  for (const name of names) {
    const value = optional(params, name)
    const problem = value === null ? null : spec.filters[name](value)
    if (problem !== null) return { ok: false, error: problem }
    filters[name] = value
  }
  return { ok: true, value: { page, pageSize: LIST_PAGE_SIZE, sort: sort as S, dir, filters } }
}
