// Memory: everything Kinfold keeps, as a table you can sort by age or by how
// often it was recalled. A row's panel shows the memory, where it came from,
// what it confirms or replaces, and a way to forget it. Forgetting runs a dry
// run first and says what it would remove; on a central device it is done on
// the hub, so the button says so instead.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ExternalLink } from 'lucide-react'
import { useState } from 'react'
import { AgentFilter, DeviceFilter, ProjectFilter } from '../components/filters'
import { type ListColumn, ListView } from '../components/list-view'
import { PageHeader } from '../components/page'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Select } from '../components/ui/input'
import { Notice } from '../components/ui/notice'
import { Skeleton } from '../components/ui/skeleton'
import { api, errorText, get } from '../lib/api'
import { agentName, ago, dateOnly, deviceName, plural } from '../lib/format'
import { type ListSearch, withFilter } from '../lib/list-search'
import { useDeviceNames, useFacets, useHubOnly } from '../lib/queries'
import { describeCounts } from '../lib/purge'
import type { MemoryDetail, MemoryRow } from '../lib/types'

const KINDS: Readonly<Record<string, string>> = {
  discovery: 'Discovery', decision: 'Decision', bugfix: 'Fix', feature: 'Feature', refactor: 'Refactor', change: 'Change', problem: 'Problem',
}
export const kindName = (type: string): string => KINDS[type] ?? type.charAt(0).toUpperCase() + type.slice(1)

const EVIDENCE: Readonly<Record<string, string>> = {
  'tool-verified': 'Checked against what a tool showed',
  interpretation: 'The agent\'s reading of what happened',
  'user-stated': 'You said so',
}

const LINKS: Readonly<Record<string, [string, string]>> = {
  confirms: ['Confirms', 'Confirmed by'],
  updates: ['Replaces', 'Replaced by'],
  contradicts: ['Contradicts', 'Contradicted by'],
}

function KindFilter({ search, onSearch }: { search: ListSearch; onSearch: (next: ListSearch) => void }) {
  const types = useFacets().data?.types ?? []
  return (
    <>
      <label htmlFor="memory-kind" className="sr-only">Kind</label>
      <Select id="memory-kind" value={search.type ?? ''} onChange={(event) => onSearch(withFilter(search, { type: event.target.value }))}>
        <option value="">All kinds</option>
        {types.map((type) => <option key={type.value} value={type.value}>{kindName(type.value)}</option>)}
      </Select>
    </>
  )
}

export function MemoryPage() {
  const search = useSearch({ strict: false }) as ListSearch
  const navigate = useNavigate()
  const { names, here, central, since } = useDeviceNames()
  const onSearch = (next: ListSearch): void => void navigate({ to: '/memory', search: next })
  const columns: ListColumn<MemoryRow>[] = [
    { id: 'title', header: 'Memory', sort: 'title', cell: (row) => <span className={row.contradicted ? 'text-muted line-through decoration-muted/50' : 'font-medium'}>{row.title}</span> },
    { id: 'project', header: 'Project', sort: 'project', cell: (row) => row.project },
    { id: 'kind', header: 'Kind', sort: 'kind', wide: true, cell: (row) => <Badge>{kindName(row.type)}</Badge> },
    { id: 'age', header: 'Saved', sort: 'age', className: 'whitespace-nowrap', cell: (row) => ago(row.occurredAt) },
    { id: 'from', header: 'From', wide: true, cell: (row) => (central ? `${agentName(row.host)} on ${deviceName(row.device, names, here, since)}` : agentName(row.host)) },
    { id: 'recalls', header: 'Recalled', sort: 'recalls', className: 'tabular-nums whitespace-nowrap', cell: (row) => (row.recallCount === 0 ? 'not yet' : plural(row.recallCount, 'time', 'times')) },
  ]
  return (
    <>
      <PageHeader title="Memory">What your agents learned and Kinfold kept. Recalled shows how often a memory was handed to an agent.</PageHeader>
      <ListView
        noun="memories"
        endpoint="/memory/list/memories"
        search={search}
        onSearch={onSearch}
        columns={columns}
        rowId={(row) => row.id}
        defaultSort="age"
        defaultDir="desc"
        searchLabel="Search memory by words"
        filters={<><ProjectFilter search={search} onSearch={onSearch} /><AgentFilter search={search} onSearch={onSearch} /><KindFilter search={search} onSearch={onSearch} /><DeviceFilter search={search} onSearch={onSearch} /></>}
        empty={search.q !== undefined ? 'No memory matches those words.' : 'No memories yet. They appear after your first session with an agent Kinfold is set up for.'}
        panel={(id) => ({
          title: <MemoryTitle id={id} />,
          actions: <Button asChild variant="ghost" size="sm"><Link to="/memory/$id" params={{ id }}>Open full page<ExternalLink aria-hidden="true" className="h-3.5 w-3.5" /></Link></Button>,
          body: <MemoryBody id={id} onForgotten={() => onSearch({ ...search, open: undefined })} />,
        })}
      />
    </>
  )
}

function useMemory(id: number) {
  return useQuery({ queryKey: ['/memory/observations', id], queryFn: () => get<MemoryDetail>(`/memory/observations/${id}`) })
}

function MemoryTitle({ id }: { id: number }) {
  const memory = useMemory(id).data
  return <>{memory?.title ?? 'Memory'}</>
}

export function MemoryFullPage() {
  const { id } = useParams({ strict: false }) as { id: number }
  const navigate = useNavigate()
  const memory = useMemory(id).data
  return (
    <div className="mx-auto max-w-3xl">
      <p className="mb-3 text-sm"><Link to="/memory" className="text-accent hover:underline">← All memory</Link></p>
      <PageHeader title={memory?.title ?? 'Memory'} />
      <MemoryBody id={id} onForgotten={() => void navigate({ to: '/memory' })} />
    </div>
  )
}

function MemoryBody({ id, onForgotten }: { id: number; onForgotten: () => void }) {
  const memory = useMemory(id)
  const { names, here, central, since } = useDeviceNames()
  if (memory.isError) return <Notice tone="bad">{errorText(memory.error)}</Notice>
  if (memory.data === undefined) return <div className="space-y-3"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-28 w-full" /></div>
  const m = memory.data
  return (
    <div className="space-y-5 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">{kindName(m.type)}</Badge>
        <span className="text-muted">{EVIDENCE[m.evidence] ?? m.evidence}</span>
      </div>
      {m.contradictedBy !== null ? <Notice tone="warn">A newer memory replaced or contradicted this one, so agents are no longer given it. <Link to="/memory" search={{ open: m.contradictedBy }} className="font-medium text-accent hover:underline">See the newer one</Link></Notice> : null}
      {m.narrative !== '' ? <p className="leading-relaxed whitespace-pre-wrap break-words">{m.narrative}</p> : null}
      {m.facts.length > 0 ? (
        <section aria-label="Facts"><h3 className="mb-1 text-xs font-medium text-muted">Facts</h3><ul className="list-disc space-y-1 pl-5">{m.facts.map((fact, index) => <li key={index} className="break-words">{fact}</li>)}</ul></section>
      ) : null}
      {m.files.length > 0 ? (
        <section aria-label="Files"><h3 className="mb-1 text-xs font-medium text-muted">Files</h3><ul className="space-y-0.5 font-mono text-xs">{m.files.map((file) => <li key={file} className="break-all">{file}</li>)}</ul></section>
      ) : null}
      <section aria-label="Where it came from" className="rounded-lg bg-surface-2 p-3">
        <h3 className="mb-2 text-xs font-medium text-muted">Where it came from</h3>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-muted">Project</dt><dd>{m.projectName ?? m.projectKey}</dd>
          <dt className="text-muted">Agent</dt><dd>{agentName(m.host)}{central ? ` on ${deviceName(m.device, names, here, since)}` : ''}</dd>
          <dt className="text-muted">Saved</dt><dd>{dateOnly(m.occurredAt)}</dd>
          <dt className="text-muted">Recalled</dt><dd>{m.recallCount === 0 ? 'Not yet' : plural(m.recallCount, 'time', 'times')}</dd>
          {m.sessionId !== null ? <><dt className="text-muted">Session</dt><dd><Link to="/sessions" search={{ open: m.sessionId }} className="text-accent hover:underline">Open the session</Link></dd></> : null}
        </dl>
      </section>
      {m.links.length > 0 ? (
        <section aria-label="Linked memories">
          <h3 className="mb-1 text-xs font-medium text-muted">Linked memories</h3>
          <ul className="space-y-1">
            {m.links.map((link) => (
              <li key={`${link.kind}-${link.direction}-${link.id}`}>
                <span className="text-muted">{LINKS[link.kind]?.[link.direction === 'outgoing' ? 0 : 1] ?? link.kind}: </span>
                <Link to="/memory" search={{ open: link.id }} className="text-accent hover:underline">{link.title}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <Forget id={m.id} onForgotten={onForgotten} />
    </div>
  )
}

interface PurgeReport {
  dryRun: boolean
  counts: Record<string, number>
}

function Forget({ id, onForgotten }: { id: number; onForgotten: () => void }) {
  const { hubOnly, hub } = useHubOnly()
  const client = useQueryClient()
  const [preview, setPreview] = useState<PurgeReport | null>(null)
  const dryRun = useMutation({ mutationFn: () => api<PurgeReport>('POST', '/data/purge', { observation: id, dryRun: true }), onSuccess: setPreview })
  const purge = useMutation({
    mutationFn: () => api<PurgeReport>('POST', '/data/purge', { observation: id, dryRun: false }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['/memory/list/memories'] })
      onForgotten()
    },
  })
  if (hubOnly) return <section aria-label="Forget"><Button variant="dangerQuiet" size="sm" disabled>Forget this memory</Button><p className="mt-1 text-xs text-muted">This device uses memory kept on {hub}. Forget it there, in that computer's dashboard.</p></section>
  const failed = dryRun.error ?? purge.error
  return (
    <section aria-label="Forget" className="border-t border-border pt-4">
      {preview === null ? (
        <Button variant="dangerQuiet" size="sm" disabled={dryRun.isPending} onClick={() => dryRun.mutate()}>Forget this memory…</Button>
      ) : (
        <div className="space-y-2">
          <p>Forgetting removes {describeCounts(preview.counts)}. Agents will not be given it again. This cannot be undone, except by restoring a backup.</p>
          <div className="flex gap-2">
            <Button variant="danger" size="sm" disabled={purge.isPending} onClick={() => purge.mutate()}>Forget it</Button>
            <Button variant="quiet" size="sm" onClick={() => setPreview(null)}>Keep it</Button>
          </div>
        </div>
      )}
      {failed !== null ? <Notice tone="bad" className="mt-2">{errorText(failed)}</Notice> : null}
    </section>
  )
}
