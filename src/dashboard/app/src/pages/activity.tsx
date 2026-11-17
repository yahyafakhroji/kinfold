// Activity: what Kinfold did, newest first, in sentences: memory recalled and
// saved, summaries and why they failed, backups, restores, updates, sign-ins
// and devices joining. On a central device the list is the hub's, and this
// device's own link to the hub is shown above it. The daemon's raw log is a
// download for anyone who needs more.

import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { Download } from 'lucide-react'
import { type ListColumn, ListView } from '../components/list-view'
import { PageHeader } from '../components/page'
import { Button } from '../components/ui/button'
import { Card, CardTitle } from '../components/ui/card'
import { Select } from '../components/ui/input'
import { Notice } from '../components/ui/notice'
import { KIND_LABELS, activitySentence } from '../lib/activity'
import { get } from '../lib/api'
import { agentName, ago, deviceName, plural, when } from '../lib/format'
import { type ListSearch, withFilter } from '../lib/list-search'
import { useCentral, useDeviceNames } from '../lib/queries'
import { ACTIVITY_KINDS, type ActivityRow, type ListPage } from '../lib/types'

function ThisDevice() {
  const central = useCentral().data
  if (central?.role !== 'device') return null
  return (
    <Card className="mb-5" aria-label="This device">
      <CardTitle>This device</CardTitle>
      {central.reachable ? (
        <p className="text-sm">Connected to {central.hub}{central.lastContactAt !== null ? `, last heard from ${ago(central.lastContactAt)}` : ''}. {central.queued > 0 ? `${plural(central.queued, 'capture is', 'captures are')} waiting to be sent.` : 'Nothing is waiting to be sent.'}</p>
      ) : (
        <Notice tone="bad">This device cannot reach {central.hub}{central.problem !== null ? `: ${central.problem}` : ''}. {plural(central.queued, 'capture waits', 'captures wait')} here and will be sent when it is back.</Notice>
      )}
      <DeviceEvents />
      <p className="mt-2 text-xs text-muted">The list below is the hub's activity, which includes what this device sends it.</p>
    </Card>
  )
}

/** This device's own events, which it keeps in memory: the hub never sees them. */
function DeviceEvents() {
  const events = useQuery({ queryKey: ['/dashboard/device-activity'], queryFn: () => get<{ rows: ActivityRow[] }>('/dashboard/device-activity') })
  const rows = events.data?.rows ?? []
  if (rows.length === 0) return null
  return (
    <ul className="mt-3 divide-y divide-border/70 text-sm">
      {rows.slice(0, 5).map((row) => <li key={row.id} className="flex justify-between gap-4 py-1.5"><span>{activitySentence(row)} on this device</span><span className="text-muted tabular-nums">{when(row.at)}</span></li>)}
    </ul>
  )
}

export function ActivityPage() {
  const search = useSearch({ strict: false }) as ListSearch
  const navigate = useNavigate()
  const { names } = useDeviceNames()
  const onSearch = (next: ListSearch): void => void navigate({ to: '/activity', search: next })
  const columns: ListColumn<ActivityRow>[] = [
    { id: 'when', header: 'When', className: 'whitespace-nowrap tabular-nums text-muted', cell: (row) => when(row.at) },
    { id: 'what', header: 'What happened', cell: (row) => activitySentence(row, names) },
  ]
  return (
    <>
      <PageHeader
        title="Activity"
        aside={<Button asChild variant="quiet" size="sm"><a href="/dashboard/daemon-log" download><Download aria-hidden="true" className="h-3.5 w-3.5" />Download the daemon log</a></Button>}
      >
        What Kinfold did for your agents, and the things you did here. Kept for 90 days.
      </PageHeader>
      <ThisDevice />
      <ListView
        noun="events"
        endpoint="/memory/list/activity"
        search={search}
        onSearch={onSearch}
        columns={columns}
        rowId={(row) => row.id}
        defaultSort="time"
        defaultDir="desc"
        filters={
          <>
            <label htmlFor="activity-kind" className="sr-only">What happened</label>
            <Select id="activity-kind" value={search.kind ?? ''} onChange={(event) => onSearch(withFilter(search, { kind: event.target.value }))}>
              <option value="">Everything</option>
              {ACTIVITY_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
            </Select>
          </>
        }
        empty={search.kind !== undefined ? 'Nothing of this kind in the last 90 days.' : 'Nothing yet. Recalls, saved memories, backups and updates show up here as they happen.'}
        panel={(id) => ({ title: 'What happened', body: <ActivityDetail id={id} search={search} /> })}
      />
    </>
  )
}

/** The row comes from the page already loaded; no extra request. */
function ActivityDetail({ id, search }: { id: number; search: ListSearch }) {
  const { open: _open, ...params } = search
  const page = useQuery({ queryKey: ['/memory/list/activity', params], queryFn: () => get<ListPage<ActivityRow>>('/memory/list/activity'), enabled: false })
  const { names, here, central } = useDeviceNames()
  const row = page.data?.rows.find((entry) => entry.id === id)
  if (row === undefined) return <p className="text-sm text-muted">This event is on another page of the list.</p>
  return (
    <div className="space-y-4 text-sm">
      <p className="text-base">{activitySentence(row, names)}.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted">When</dt><dd>{when(row.at)}</dd>
        {row.host !== null ? <><dt className="text-muted">Agent</dt><dd>{agentName(row.host)}</dd></> : null}
        {row.project !== null ? <><dt className="text-muted">Project</dt><dd>{row.project}</dd></> : null}
        {central && row.device !== null ? <><dt className="text-muted">Device</dt><dd>{deviceName(row.device, names, here)}</dd></> : null}
      </dl>
      {row.sessionId !== null ? <Link to="/sessions" search={{ open: row.sessionId }} className="text-accent hover:underline">Open the session</Link> : null}
    </div>
  )
}
