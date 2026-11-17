// Sessions: every session as a table row, newest first. A row's side panel
// shows what it saved, then each turn: your prompt, the memory it was given,
// the agent's reply, and what Kinfold saved from it, with the summary a click
// away. Turns load 20 at a time and only the ones in view are drawn, so a
// session of hundreds of turns opens as fast as a short one.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { useVirtualizer, useWindowVirtualizer } from '@tanstack/react-virtual'
import { ExternalLink } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { AgentFilter, DeviceFilter, ProjectFilter } from '../components/filters'
import { type ListColumn, ListView } from '../components/list-view'
import { PageHeader } from '../components/page'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Info } from '../components/ui/info'
import { Notice } from '../components/ui/notice'
import { Skeleton } from '../components/ui/skeleton'
import { errorText, get } from '../lib/api'
import { agentName, count, deviceName, plural, savedLabel, when } from '../lib/format'
import type { ListSearch } from '../lib/list-search'
import { useDeviceNames } from '../lib/queries'
import type { SessionHeader, SessionRow, SessionTurn, TurnsPage } from '../lib/types'

function SavedCell({ row }: { row: SessionRow }) {
  const label = savedLabel(row.saved)
  return (
    <span className="whitespace-nowrap">
      <span className={label.tone === 'good' ? 'text-good' : label.tone === 'bad' ? 'text-bad' : 'text-muted'}>{label.text}</span>
      {row.saved.kind !== 'none' ? <span className="ml-1.5 text-xs text-muted">{label.source}</span> : null}
    </span>
  )
}

export function SessionsPage() {
  const search = useSearch({ strict: false }) as ListSearch
  const navigate = useNavigate()
  const { names, here, central, since } = useDeviceNames()
  const onSearch = (next: ListSearch): void => void navigate({ to: '/sessions', search: next })
  const columns: ListColumn<SessionRow>[] = [
    { id: 'started', header: 'Started', sort: 'started', cell: (row) => <span className="whitespace-nowrap tabular-nums">{when(row.startedAt)}</span> },
    { id: 'project', header: 'Project', sort: 'project', cell: (row) => <span className="font-medium">{row.project}</span> },
    { id: 'agent', header: 'Agent', sort: 'agent', cell: (row) => agentName(row.host) },
    ...(central ? [{ id: 'device', header: 'Device', sort: 'device', wide: true, cell: (row: SessionRow) => deviceName(row.device, names, here, since) }] : []),
    { id: 'prompts', header: 'Prompts', sort: 'prompts', className: 'tabular-nums', cell: (row) => count(row.prompts) },
    { id: 'memory', header: 'Got memory', wide: true, className: 'tabular-nums whitespace-nowrap', cell: (row) => (row.prompts === 0 ? '—' : `${count(row.promptsWithMemory)} of ${count(row.prompts)}`) },
    { id: 'saved', header: 'Saved', wide: true, cell: (row) => <SavedCell row={row} /> },
  ]
  return (
    <>
      <PageHeader title="Sessions">Each time you worked with an agent. Open one to see what it was given and what Kinfold saved from it.</PageHeader>
      <ListView
        noun="sessions"
        endpoint="/memory/list/sessions"
        search={search}
        onSearch={onSearch}
        columns={columns}
        rowId={(row) => row.id}
        defaultSort="started"
        defaultDir="desc"
        searchLabel="Search by project or folder"
        filters={<><ProjectFilter search={search} onSearch={onSearch} /><AgentFilter search={search} onSearch={onSearch} /><DeviceFilter search={search} onSearch={onSearch} /></>}
        empty="No sessions yet. They appear here after you work with an agent that Kinfold is set up for."
        panel={(id) => ({
          title: <SessionTitle id={id} />,
          subtitle: <SessionSubtitle id={id} />,
          actions: <Button asChild variant="ghost" size="sm"><Link to="/sessions/$id" params={{ id }}>Open full page<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></Link></Button>,
          body: <SessionDetail id={id} scroll="panel" />,
        })}
      />
    </>
  )
}

function useSession(id: number) {
  return useQuery({ queryKey: ['/memory/sessions', id], queryFn: () => get<SessionHeader>(`/memory/sessions/${id}`) })
}

function SessionTitle({ id }: { id: number }) {
  const session = useSession(id).data
  return <>{session === undefined ? 'Session' : `${session.project} · ${agentName(session.host)}`}</>
}

function SessionSubtitle({ id }: { id: number }) {
  const session = useSession(id).data
  const { names, here, central, since } = useDeviceNames()
  if (session === undefined) return <>Loading…</>
  return <>{[when(session.startedAt), central ? deviceName(session.device, names, here, since) : null, plural(session.prompts, 'prompt', 'prompts')].filter((part) => part !== null).join(' · ')}</>
}

export function SessionFullPage() {
  const { id } = useParams({ strict: false }) as { id: number }
  const session = useSession(id).data
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-3 text-sm"><Link to="/sessions" className="text-accent hover:underline">← All sessions</Link></p>
      <PageHeader title={session === undefined ? 'Session' : `${session.project} · ${agentName(session.host)}`}><SessionSubtitle id={id} /></PageHeader>
      <SessionDetail id={id} scroll="window" />
    </div>
  )
}

function SavedBox({ session }: { session: SessionHeader }) {
  const label = savedLabel(session.saved)
  const tone = label.tone === 'good' ? 'good' : label.tone === 'bad' ? 'bad' : 'info'
  const headline = session.saved.kind === 'none' ? 'No memory was used in this session' : session.saved.kind === 'measured' && session.saved.status === 'no-difference' ? label.text : label.tone === 'bad' ? `${label.text} tokens` : `Saved ${label.text} tokens`
  return (
    <Notice tone={tone} className="mb-4">
      <span className="font-semibold">{headline}</span>
      {session.saved.kind !== 'none' ? <span className="ml-1.5 text-xs text-muted">{label.source}</span> : null}
      <Info label="tokens saved">{label.explain}</Info>
      {session.startMemories > 0 ? <div className="mt-1 text-muted">It started with {plural(session.startMemories, 'memory', 'memories')} from earlier work.</div> : null}
    </Notice>
  )
}

function SessionDetail({ id, scroll }: { id: number; scroll: 'panel' | 'window' }) {
  const session = useSession(id)
  const turns = useInfiniteQuery({
    queryKey: ['/memory/sessions/turns', id],
    queryFn: ({ pageParam }) => get<TurnsPage>(`/memory/sessions/${id}/turns${pageParam === 0 ? '' : `?after=${pageParam}`}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextAfter ?? undefined,
  })
  if (session.isError) return <Notice tone="bad">{errorText(session.error)}</Notice>
  const all = turns.data?.pages.flatMap((page) => page.turns) ?? []
  const more = { has: turns.hasNextPage, loading: turns.isFetchingNextPage, load: () => void turns.fetchNextPage() }
  return (
    <div>
      {session.data !== undefined ? <SavedBox session={session.data} /> : <Skeleton className="mb-4 h-14 w-full" />}
      {turns.isPending ? <div className="space-y-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div> : null}
      {turns.isError ? <Notice tone="bad">{errorText(turns.error)}</Notice> : null}
      {turns.data !== undefined && all.length === 0 ? <p className="text-sm text-muted">No prompts were recorded in this session.</p> : null}
      {all.length > 0 ? (scroll === 'panel' ? <PanelTurns turns={all} more={more} /> : <WindowTurns turns={all} more={more} />) : null}
    </div>
  )
}

interface More {
  has: boolean
  loading: boolean
  load: () => void
}

const TURN_ESTIMATE_PX = 220

function PanelTurns({ turns, more }: { turns: SessionTurn[]; more: More }) {
  const ref = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: turns.length, getScrollElement: () => ref.current?.closest<HTMLElement>('[data-scroll]') ?? null, estimateSize: () => TURN_ESTIMATE_PX, overscan: 4 })
  return <VirtualTurns ref={ref} turns={turns} more={more} items={virtualizer.getVirtualItems()} total={virtualizer.getTotalSize()} measure={virtualizer.measureElement} />
}

function WindowTurns({ turns, more }: { turns: SessionTurn[]; more: More }) {
  const ref = useRef<HTMLDivElement>(null)
  const virtualizer = useWindowVirtualizer({ count: turns.length, estimateSize: () => TURN_ESTIMATE_PX, overscan: 4, scrollMargin: ref.current?.offsetTop ?? 0 })
  return <VirtualTurns ref={ref} turns={turns} more={more} items={virtualizer.getVirtualItems()} total={virtualizer.getTotalSize()} measure={virtualizer.measureElement} offset={virtualizer.options.scrollMargin} />
}

interface VirtualTurnsProps {
  ref: React.RefObject<HTMLDivElement | null>
  turns: SessionTurn[]
  more: More
  items: { index: number; start: number; key: React.Key }[]
  total: number
  measure: (element: Element | null) => void
  offset?: number
}

function VirtualTurns({ ref, turns, more, items, total, measure, offset = 0 }: VirtualTurnsProps) {
  const last = items.at(-1)?.index ?? -1
  useEffect(() => {
    if (last >= turns.length - 2 && more.has && !more.loading) more.load()
  }, [last, turns.length, more])
  // Positioned through the DOM (top and transform set by React as style properties), which the CSP allows.
  return (
    <div ref={ref}>
      <ol aria-label="Turns" className="relative" style={{ height: total }}>
        {items.map((item) => (
          <li key={item.key} data-index={item.index} ref={measure} className="absolute left-0 right-0 pb-3" style={{ transform: `translateY(${item.start - offset}px)` }}>
            <TurnCard turn={turns[item.index]!} />
          </li>
        ))}
      </ol>
      {more.loading ? <Skeleton className="h-20 w-full" /> : null}
    </div>
  )
}

function TurnCard({ turn }: { turn: SessionTurn }) {
  return (
    <article className="rounded-xl border border-border bg-surface p-4 text-sm">
      <header className="mb-1 flex items-center justify-between text-xs text-muted">
        <span>You · {when(turn.at)}</span>
        <span className="flex gap-1">
          {turn.heldOut ? <Badge tone="accent">Impact test: no memory</Badge> : null}
          {turn.late ? <Badge tone="warn">Memory came late</Badge> : null}
        </span>
      </header>
      <p className="whitespace-pre-wrap break-words">{turn.expired ? <span className="text-muted">Removed by your retention setting.</span> : turn.prompt}</p>
      <Recall turn={turn} />
      {turn.reply !== null ? (
        <div className="mt-3 border-t border-border/70 pt-3">
          <div className="mb-1 text-xs text-muted">The agent replied</div>
          <p className="line-clamp-6 whitespace-pre-wrap break-words">{turn.reply}</p>
        </div>
      ) : null}
      {turn.saved.length > 0 || turn.summary !== null ? (
        <div className="mt-3 text-xs text-muted">
          {turn.saved.length > 0 ? (
            <span>Saved from this turn: {turn.saved.map((memory, index) => (
              <span key={memory.id}>{index > 0 ? ' · ' : ''}<Link to="/memory" search={{ open: memory.id }} className="text-accent hover:underline">{memory.title}</Link></span>
            ))}</span>
          ) : null}
          {turn.summary !== null ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-accent">Summary</summary>
              <dl className="mt-2 grid gap-1 text-text">
                {[['Asked', turn.summary.request], ['Learned', turn.summary.learned], ['Done', turn.summary.completed], ['Next', turn.summary.nextSteps]]
                  .filter((entry): entry is [string, string] => entry[1] !== null && entry[1] !== '')
                  .map(([label, text]) => <div key={label}><dt className="inline font-medium">{label}: </dt><dd className="inline">{text}</dd></div>)}
              </dl>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function Recall({ turn }: { turn: SessionTurn }) {
  if (turn.heldOut) return <p className="mt-2 text-xs text-muted">The impact test held memory back for this prompt, to measure what memory changes.</p>
  if (!turn.recallKnown) return <p className="mt-2 text-xs text-muted">What memory this prompt got was not recorded; Kinfold started recording it on a later upgrade.</p>
  if (turn.recalled.length === 0) return <p className="mt-2 text-xs text-muted">No memory was needed for this prompt.</p>
  return (
    <p className="mt-2 text-xs">
      <span className="text-muted">Memory used: </span>
      {turn.recalled.map((memory, index) => (
        <span key={`${memory.id}-${index}`}>{index > 0 ? ' · ' : ''}<Link to="/memory" search={{ open: memory.id }} className="text-accent hover:underline">{memory.title === '' ? `memory ${memory.id} (since removed)` : memory.title}</Link></span>
      ))}
      {turn.late ? <span className="text-muted"> It arrived after the agent had started, so it was sent again with the next prompt.</span> : null}
    </p>
  )
}

