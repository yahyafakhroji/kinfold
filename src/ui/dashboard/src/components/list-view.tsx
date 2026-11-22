// The one list pattern every page uses: a table whose sorting, filtering and
// paging happen on the daemon (pages of 50), so a 30,000-row store stays as
// fast as an empty one. Clicking a row (or pressing Enter on it) opens its
// detail in a side panel; the page, sort, filters and the open row all live in
// the URL, so links and Back keep working.

import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table'
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from 'lucide-react'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { errorText, get, queryString } from '../lib/api'
import { cn } from '../lib/cn'
import { count } from '../lib/format'
import { type ListSearch, apiParams, withFilter } from '../lib/list-search'
import type { ListPage } from '../lib/types'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Notice } from './ui/notice'
import { SidePanel } from './ui/side-panel'
import { Skeleton } from './ui/skeleton'

export interface ListColumn<T> {
  id: string
  header: string
  cell: (row: T) => ReactNode
  /** Set when the daemon can sort by this column; the value is its sort key. */
  sort?: string
  className?: string
  /** Hidden on narrow screens. */
  wide?: boolean
}

export interface PanelSpec {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  body: ReactNode
}

export interface ListViewProps<T> {
  /** The plural noun for the pager: "sessions". */
  noun: string
  endpoint: string
  search: ListSearch
  onSearch: (next: ListSearch) => void
  columns: ListColumn<T>[]
  rowId: (row: T) => number
  defaultSort: string
  defaultDir: 'asc' | 'desc'
  searchLabel?: string
  filters?: ReactNode
  empty: ReactNode
  panel?: (id: number) => PanelSpec
}

const DEBOUNCE_MS = 300

function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const [text, setText] = useState(value)
  const id = useId()
  useEffect(() => setText(value), [value])
  useEffect(() => {
    if (text === value) return
    const timer = setTimeout(() => onChange(text), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [text, value, onChange])
  return (
    <div className="min-w-48 flex-1">
      <label htmlFor={id} className="sr-only">{label}</label>
      <Input id={id} type="search" placeholder={label} value={text} onChange={(event) => setText(event.target.value)} autoComplete="off" spellCheck={false} />
    </div>
  )
}

function Pager({ page, pageSize, total, noun, onPage }: { page: number; pageSize: number; total: number; noun: string; onPage: (page: number) => void }) {
  const last = Math.max(1, Math.ceil(total / pageSize))
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <nav aria-label={`${noun} pages`} className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 text-sm text-muted">
      <span aria-live="polite">{total === 0 ? `No ${noun}` : `${count(from)} to ${count(to)} of ${count(total)} ${noun}`}</span>
      <span className="flex items-center gap-1">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft aria-hidden="true" className="h-4 w-4" />Prev</Button>
        <span className="px-1 tabular-nums">Page {count(page)} of {count(last)}</span>
        <Button variant="ghost" size="sm" disabled={page >= last} onClick={() => onPage(page + 1)}>Next<ChevronRight aria-hidden="true" className="h-4 w-4" /></Button>
      </span>
    </nav>
  )
}

export function ListView<T>(props: ListViewProps<T>) {
  const { search, onSearch, columns, endpoint, noun } = props
  const params = apiParams(search)
  const query = useQuery({
    queryKey: [endpoint, params],
    queryFn: () => get<ListPage<T>>(`${endpoint}${queryString(params)}`),
    placeholderData: keepPreviousData,
  })
  const sort = search.sort ?? props.defaultSort
  const dir = search.dir ?? props.defaultDir
  const tableColumns: ColumnDef<T>[] = columns.map((column) => ({ id: column.id, header: column.header, cell: (info) => column.cell(info.row.original) }))
  const table = useReactTable({ data: query.data?.rows ?? [], columns: tableColumns, getCoreRowModel: getCoreRowModel(), manualSorting: true, manualPagination: true })
  const byId = new Map(columns.map((column) => [column.id, column]))

  const sortBy = (key: string): void => {
    const nextDir = key === sort ? (dir === 'asc' ? 'desc' : 'asc') : key === props.defaultSort ? props.defaultDir : 'asc'
    onSearch(withFilter(search, { sort: key === props.defaultSort && nextDir === props.defaultDir ? undefined : key, dir: key === props.defaultSort && nextDir === props.defaultDir ? undefined : nextDir }))
  }
  const openRow = (id: number): void => onSearch({ ...search, open: id })
  const panel = search.open !== undefined && props.panel !== undefined ? props.panel(search.open) : null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {props.searchLabel !== undefined ? <SearchBox label={props.searchLabel} value={search.q ?? ''} onChange={(q) => onSearch(withFilter(search, { q }))} /> : null}
        {props.filters}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" aria-busy={query.isFetching}>
            <thead>
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className="border-b border-border text-left text-xs text-muted">
                  {group.headers.map((header) => {
                    const column = byId.get(header.id)
                    const sorted = column?.sort !== undefined && column.sort === sort
                    return (
                      <th key={header.id} scope="col" aria-sort={sorted ? (dir === 'asc' ? 'ascending' : 'descending') : undefined} className={cn('px-4 py-2.5 font-medium whitespace-nowrap', column?.wide === true && 'hidden md:table-cell', column?.className)}>
                        {column?.sort !== undefined ? (
                          <button type="button" onClick={() => sortBy(column.sort!)} className={cn('inline-flex cursor-pointer items-center gap-1 rounded hover:text-text', sorted && 'text-text')}>
                            {column.header}
                            {sorted ? (dir === 'asc' ? <ArrowUp aria-hidden="true" className="h-3 w-3" /> : <ArrowDown aria-hidden="true" className="h-3 w-3" />) : null}
                          </button>
                        ) : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    )
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {query.isPending ? (
                Array.from({ length: 8 }, (_, index) => (
                  <tr key={index} className="border-b border-border/60 last:border-0">
                    {columns.map((column) => <td key={column.id} className={cn('px-4 py-3', column.wide === true && 'hidden md:table-cell')}><Skeleton className="h-4 w-full max-w-40" /></td>)}
                  </tr>
                ))
              ) : table.getRowModel().rows.map((row) => {
                const id = props.rowId(row.original)
                const active = search.open === id
                return (
                  <tr
                    key={id}
                    onClick={() => openRow(id)}
                    className={cn('cursor-pointer border-b border-border/60 transition-colors last:border-0 hover:bg-surface-2', active && 'bg-accent-soft hover:bg-accent-soft')}
                  >
                    {row.getVisibleCells().map((cell, index) => {
                      const column = byId.get(cell.column.id)
                      const content = flexRender(cell.column.columnDef.cell, cell.getContext())
                      return (
                        <td key={cell.id} className={cn('px-4 py-2.5 align-top', column?.wide === true && 'hidden md:table-cell', column?.className)}>
                          {index === 0 ? (
                            <button type="button" aria-pressed={active} onClick={(event) => { event.stopPropagation(); openRow(id) }} className="cursor-pointer text-left hover:underline">{content}</button>
                          ) : content}
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        {query.isError ? <div className="p-4"><Notice tone="bad">{errorText(query.error)}</Notice></div> : null}
        {query.data !== undefined && query.data.total === 0 ? <div className="px-4 py-10 text-center text-sm text-muted">{props.empty}</div> : null}
        {query.data !== undefined ? <Pager page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} noun={noun} onPage={(page) => onSearch({ ...search, page: page > 1 ? page : undefined })} /> : null}
      </div>
      {panel !== null ? (
        <SidePanel open title={panel.title} subtitle={panel.subtitle} actions={panel.actions} onClose={() => onSearch({ ...search, open: undefined })}>
          {panel.body}
        </SidePanel>
      ) : null}
    </div>
  )
}
