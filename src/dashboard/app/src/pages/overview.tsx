// Overview: is Kinfold working, and is it worth it, in sentences first and
// numbers second. The "worth it" sentence follows the measured result when
// there is one, including when it found no saving, and says what memory still
// does for the agents.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleAlert, CircleCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { AsOf, PageHeader } from '../components/page'
import { Card, CardTitle } from '../components/ui/card'
import { Info } from '../components/ui/info'
import { Notice } from '../components/ui/notice'
import { Skeleton } from '../components/ui/skeleton'
import { activitySentence, problemText } from '../lib/activity'
import { errorText, get } from '../lib/api'
import { agentName, ago, count, plural, tokens, when } from '../lib/format'
import { useCentral, useDeviceNames, useUpdate } from '../lib/queries'
import type { ActivityRow, CentralStatus, Impact, Kept, ListPage, Measured, Overview, RestoreStatus, UpdateView } from '../lib/types'

const WEEK_MS = 7 * 86_400_000
const STALE_BACKUP_MS = 7 * 86_400_000

interface Look {
  text: ReactNode
  tone: 'warn' | 'bad'
}

/** Things that need the reader, most pressing first. */
export function worthALook(input: { overview: Overview; central: CentralStatus | undefined; update: UpdateView | undefined; lastBackupAt: number | null | undefined; now: number }): Look[] {
  const looks: Look[] = []
  const { overview, central, update, lastBackupAt, now } = input
  if (central?.role === 'device' && !central.reachable) looks.push({ tone: 'bad', text: `This device cannot reach ${central.hub}${central.problem !== null ? `: ${central.problem}` : ''}. Captures wait here (${plural(central.queued, 'event', 'events')}) and are sent when it is back.` })
  if (central?.role === 'hub' && central.error !== null) looks.push({ tone: 'bad', text: `Other devices cannot reach this hub: ${central.error}.` })
  for (const agent of overview.failing) {
    looks.push({ tone: 'bad', text: <>Summaries for {agentName(agent.host)} are failing: {problemText(agent.errorClass)}. New memories wait until it works again. <Link to="/settings" hash="agents" className="font-medium text-accent hover:underline">Check its settings</Link></> })
  }
  if (update?.release?.installable === true) looks.push({ tone: 'warn', text: <>Kinfold {update.release.version} is ready to install. <Link to="/settings" hash="updates" className="font-medium text-accent hover:underline">See what changed</Link></> })
  if (overview.memories > 0 && central?.role !== 'device') {
    if (lastBackupAt === null) looks.push({ tone: 'warn', text: <>You have not made a backup yet. <Link to="/backup" className="font-medium text-accent hover:underline">Back up now</Link></> })
    else if (lastBackupAt !== undefined && now - lastBackupAt > STALE_BACKUP_MS) looks.push({ tone: 'warn', text: <>Your last backup was {ago(lastBackupAt, now)}. <Link to="/backup" className="font-medium text-accent hover:underline">Back up now</Link></> })
  }
  return looks
}

/** The week in one or two sentences: how often memory was used, and what it saved by the measured rule when there is one. */
export function weekSentence(overview: Overview, measured: [string, Measured][]): string {
  const { week, saved } = overview
  if (week.prompts === 0) return 'No prompts this week yet. Kinfold starts helping as soon as an agent works in one of your projects.'
  const used = `This week your agents used memory on ${count(week.promptsWithMemory)} of ${count(week.prompts)} prompts.`
  const results = measured.map(([, result]) => result).filter((result): result is Exclude<Measured, { status: 'not-enough' }> => result.status !== 'not-enough')
  const compared = results.reduce((sum, result) => sum + result.heldOut + result.normal, 0)
  const still = ' Memory still brings back past decisions, so agents ask you less.'
  if (results.length > 0) {
    if (results.every((result) => result.status === 'no-difference')) return `${used} No measurable saving yet (${count(compared)} turns compared; the difference is within normal variation).${still}`
    if (results.every((result) => result.status === 'cost')) return `${used} Measured on your own turns, memory has cost more tokens than it saved so far (${count(compared)} turns compared).${still}`
    if (saved.measured.tokens > 0) return `${used} It saved about ${tokens(saved.measured.tokens)} tokens, measured from ${count(compared)} of your turns.`
    return `${used} The measured results are mixed so far (${count(compared)} turns compared).${still}`
  }
  if (saved.estimate.tokens > 0) return `${used} It saved up to about ${tokens(saved.estimate.tokens)} tokens (an estimate until the impact test measures your own turns).`
  return used
}

function Figure({ label, value, note, info }: { label: string; value: ReactNode; note?: ReactNode; info: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center gap-1 text-xs text-muted">{label}<Info label={label}>{info}</Info></div>
      <div className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {note !== undefined ? <div className="mt-0.5 text-xs text-muted">{note}</div> : null}
    </div>
  )
}

export function OverviewPage() {
  const overview = useQuery({ queryKey: ['/memory/overview'], queryFn: () => get<Kept<Overview>>('/memory/overview'), refetchInterval: 60_000 })
  const impact = useQuery({ queryKey: ['/memory/impact', '7d'], queryFn: () => get<Kept<Impact>>('/memory/impact?window=7d') })
  const recent = useQuery({ queryKey: ['/memory/list/activity', {}], queryFn: () => get<ListPage<ActivityRow>>('/memory/list/activity'), refetchInterval: 30_000 })
  const backup = useQuery({ queryKey: ['/restore/status'], queryFn: () => get<RestoreStatus>('/restore/status') })
  const central = useCentral().data
  const update = useUpdate().data
  const { names } = useDeviceNames()
  const now = Date.now()

  if (overview.isError) return <Notice tone="bad">{errorText(overview.error)}</Notice>
  const data = overview.data?.value
  const looks = data === undefined ? [] : worthALook({ overview: data, central, update, lastBackupAt: backup.data?.lastBackupAt, now })
  const working = looks.every((look) => look.tone !== 'bad')

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Overview" />
      {data === undefined ? (
        <div className="space-y-3"><Skeleton className="h-7 w-2/3" /><Skeleton className="h-5 w-full" /><Skeleton className="h-24 w-full" /></div>
      ) : (
        <>
          <section aria-label="Status" className="mb-6">
            <p className="flex items-center gap-2 text-xl font-semibold tracking-tight">
              {working ? <CircleCheck aria-hidden="true" className="h-5 w-5 text-good" /> : <CircleAlert aria-hidden="true" className="h-5 w-5 text-bad" />}
              {working ? 'Kinfold is working.' : 'Kinfold needs your attention.'}
            </p>
            <p className="mt-2 leading-relaxed text-muted">
              {data.memories === 0 ? 'Your first memories appear after your first session with an agent Kinfold is set up for. Run kinfold install if you have not yet.' : weekSentence(data, impact.data?.value.measured ?? [])}
            </p>
          </section>

          <div className="mb-6 grid gap-3 sm:grid-cols-3">
            <Figure label="Memories" value={count(data.memories)} note={`${plural(data.projects, 'project', 'projects')}, ${plural(data.sessions, 'session', 'sessions')}`} info="What your agents learned and Kinfold kept, such as a decision or a fix. Each memory belongs to a project." />
            <Figure label="Prompts with memory" value={data.week.prompts === 0 ? '—' : `${count(data.week.promptsWithMemory)} of ${count(data.week.prompts)}`} note="in the last 7 days" info="How many of your prompts this week were answered with something Kinfold remembered from earlier work." />
            <SavedFigure overview={data} measured={impact.data?.value.measured ?? []} />
          </div>

          {looks.length > 0 ? (
            <Card className="mb-6" aria-label="Worth a look">
              <CardTitle>Worth a look</CardTitle>
              <ul className="space-y-2">{looks.map((look, index) => <li key={index}><Notice tone={look.tone}>{look.text}</Notice></li>)}</ul>
            </Card>
          ) : null}

          <Card aria-label="Recent activity">
            <CardTitle action={<Link to="/activity" className="text-sm text-accent hover:underline">All activity</Link>}>Recent activity</CardTitle>
            {recent.data === undefined ? <Skeleton className="h-16 w-full" /> : recent.data.rows.length === 0 ? (
              <p className="text-sm text-muted">Nothing yet. Recalls, saved memories, backups and updates show up here as they happen.</p>
            ) : (
              <ul className="divide-y divide-border/70 text-sm">
                {recent.data.rows.slice(0, 6).map((row) => (
                  <li key={row.id} className="flex justify-between gap-4 py-2">
                    <span>{activitySentence(row, names)}</span>
                    <time dateTime={new Date(row.at).toISOString()} className="shrink-0 text-muted tabular-nums">{when(row.at, now)}</time>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="mt-4"><AsOf at={overview.data!.asOf} refreshing={overview.data!.refreshing} /></div>
        </>
      )}
    </div>
  )
}

function SavedFigure({ overview, measured }: { overview: Overview; measured: [string, Measured][] }) {
  const { saved } = overview
  const results = measured.map(([, result]) => result).filter((result) => result.status !== 'not-enough')
  const info = 'Measured figures come from the impact test, which compares your turns with and without memory. Until it has enough turns, Kinfold shows an estimate: what writing the memories cost, less what reading them cost. The two are never added together.'
  if (results.length > 0 && results.every((result) => result.status === 'cost') && saved.measured.tokens < 0) return <Figure label="Tokens saved" value={<span className="text-bad">Cost ~{tokens(-saved.measured.tokens)} more</span>} note="measured, last 7 days" info={info} />
  if (results.length > 0 && results.every((result) => result.status !== 'saving')) return <Figure label="Tokens saved" value="None measured yet" note="within normal variation, last 7 days" info={info} />
  if (saved.measured.sessions > 0) return <Figure label="Tokens saved" value={`~${tokens(saved.measured.tokens)}`} note={<span className="text-good">measured, last 7 days</span>} info={info} />
  if (saved.estimate.sessions > 0) return <Figure label="Tokens saved" value={`up to ~${tokens(saved.estimate.tokens)}`} note={`estimate${saved.estimate.partial ? ', partial' : ''}, last 7 days`} info={info} />
  return <Figure label="Tokens saved" value="—" note={`nothing used since ${new Date(Date.now() - WEEK_MS).toLocaleDateString('en', { day: 'numeric', month: 'short' })}`} info={info} />
}
