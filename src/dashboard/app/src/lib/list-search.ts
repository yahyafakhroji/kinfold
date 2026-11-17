// A list's state as it lives in the URL: page, sort, filters and the open
// row, so a link or Back brings the same view. Values are checked here; the
// daemon checks them again and refuses what it does not know.

export interface ListSearch {
  page?: number
  sort?: string
  dir?: 'asc' | 'desc'
  q?: string
  host?: string
  project?: string
  device?: string
  type?: string
  kind?: string
  /** The id of the row whose side panel is open. */
  open?: number
}

const TEXT_KEYS = ['sort', 'q', 'host', 'project', 'device', 'type', 'kind'] as const
const MAX_TEXT = 500

const positive = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isSafeInteger(n) && n > 0 ? n : undefined
}

export function parseListSearch(raw: Record<string, unknown>): ListSearch {
  const search: ListSearch = {}
  const page = positive(raw.page)
  if (page !== undefined && page > 1) search.page = page
  const open = positive(raw.open)
  if (open !== undefined) search.open = open
  if (raw.dir === 'asc' || raw.dir === 'desc') search.dir = raw.dir
  for (const key of TEXT_KEYS) {
    const value = raw[key]
    if (typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT) search[key] = value.trim()
  }
  return search
}

/** What the daemon is asked: everything but the open row. */
export function apiParams(search: ListSearch): Record<string, string | number | undefined> {
  const { open: _open, ...rest } = search
  return rest
}

/** A filter or sort change goes back to the first page. */
export function withFilter(search: ListSearch, change: Partial<ListSearch>): ListSearch {
  const next: ListSearch = { ...search, ...change }
  delete next.page
  for (const key of Object.keys(next) as (keyof ListSearch)[]) if (next[key] === undefined || next[key] === '') delete next[key]
  return next
}
