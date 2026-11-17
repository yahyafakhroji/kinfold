// Impact: is memory worth its tokens? The measured result (the impact test)
// and the estimate sit side by side and are never added. Below them, what
// Kinfold put into the agents' context, what writing memories cost, and the
// switch for the impact test itself.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { AsOf, PageHeader } from '../components/page'
import { Card, CardTitle } from '../components/ui/card'
import { Info } from '../components/ui/info'
import { Notice } from '../components/ui/notice'
import { Skeleton } from '../components/ui/skeleton'
import { Switch } from '../components/ui/switch'
import { api, errorText, get } from '../lib/api'
import { agentName, count, dateOnly, measuredSentence, plural, tokens } from '../lib/format'
import { useHubOnly } from '../lib/queries'
import type { Impact, Kept } from '../lib/types'
import { cn } from '../lib/cn'

interface Display {
  showRecall: boolean
  holdout: boolean
  holdoutHosts: string[]
}

function WindowToggle({ value, onChange }: { value: '7d' | '30d'; onChange: (value: '7d' | '30d') => void }) {
  return (
    <div role="radiogroup" aria-label="Period" className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
      {(['7d', '30d'] as const).map((window) => (
        <button key={window} type="button" role="radio" aria-checked={value === window} onClick={() => onChange(window)} className={cn('cursor-pointer rounded-md px-3 py-1', value === window ? 'bg-surface-2 font-medium' : 'text-muted hover:text-text')}>
          {window === '7d' ? 'Last 7 days' : 'Last 30 days'}
        </button>
      ))}
    </div>
  )
}

export function ImpactPage() {
  const search = useSearch({ strict: false }) as { window?: '30d' }
  const navigate = useNavigate()
  const window = search.window ?? '7d'
  const impact = useQuery({ queryKey: ['/memory/impact', window], queryFn: () => get<Kept<Impact>>(`/memory/impact?window=${window}`) })
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="Impact" aside={<WindowToggle value={window} onChange={(next) => void navigate({ to: '/impact', search: next === '30d' ? { window: '30d' } : {} })} />}>
        Whether memory pays for itself in tokens, measured where Kinfold can and estimated where it cannot yet.
      </PageHeader>
      {impact.isError ? <Notice tone="bad">{errorText(impact.error)}</Notice> : null}
      {impact.data === undefined ? <div className="grid gap-4 sm:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div> : <ImpactBody data={impact.data.value} />}
      {impact.data !== undefined ? <div className="mt-4"><AsOf at={impact.data.asOf} refreshing={impact.data.refreshing} /></div> : null}
    </div>
  )
}

function ImpactBody({ data }: { data: Impact }) {
  const measured = data.measured
  const period = data.window === '7d' ? 'the last 7 days' : 'the last 30 days'
  const added = data.context.reduce((sum, row) => sum + row.tokens, 0)
  const observerTokens = data.observer.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0)
  const runs = data.observer.reduce((sum, row) => sum + row.runs, 0)
  const reported = data.observer.reduce((sum, row) => sum + row.reported, 0)
  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card aria-label="Measured">
          <CardTitle action={<Info label="the measured figure">The impact test leaves memory out of about 1 prompt in 10 and compares those turns with the rest, on the same projects. Kinfold needs at least 30 turns of each kind, and says "no measurable saving" when the difference is within normal variation.</Info>}>Measured</CardTitle>
          {measured.length === 0 ? (
            <p className="text-sm text-muted">Nothing measured yet. {data.holdout.on ? 'The impact test is on and collecting turns.' : 'Turn on the impact test below to measure your own turns.'}</p>
          ) : (
            <ul className="space-y-2 text-sm">{measured.map(([host, result]) => <li key={host}>{measuredSentence(host, result)}</li>)}</ul>
          )}
          {data.saved.measured.sessions > 0 && data.saved.measured.tokens > 0 ? <p className="mt-3 text-sm">Across {plural(data.saved.measured.sessions, 'session', 'sessions')} in {period}: about <span className="font-semibold text-good">{tokens(data.saved.measured.tokens)} tokens</span> saved.</p> : null}
        </Card>
        <Card aria-label="Estimate">
          <CardTitle action={<Info label="the estimate">What it cost to write the memories each session was given, less what it cost to read them. It is an upper bound, shown only for agents the impact test has not measured.</Info>}>Estimate</CardTitle>
          {data.saved.estimate.sessions === 0 ? <p className="text-sm text-muted">No session in {period} needs an estimate.</p> : (
            <p className="text-sm">Up to about <span className="font-semibold">{tokens(data.saved.estimate.tokens)} tokens</span> across {plural(data.saved.estimate.sessions, 'session', 'sessions')} in {period}.{data.saved.estimate.partial ? ' Some memories were written before Kinfold recorded what they cost, so this leaves them out.' : ''}</p>
          )}
        </Card>
      </div>

      <Card aria-label="What Kinfold added">
        <CardTitle>What Kinfold added to your agents' context</CardTitle>
        {data.context.length === 0 ? <p className="text-sm text-muted">Nothing in {period}.</p> : (
          <>
            <p className="mb-3 text-sm">{count(added)} tokens in {period}. Memory is not free: every token here is one your agents read.</p>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs text-muted"><th scope="col" className="py-1 font-medium">Agent</th><th scope="col" className="py-1 font-medium">Per session</th><th scope="col" className="py-1 font-medium">Per prompt</th><th scope="col" className="py-1 font-medium">In total</th></tr></thead>
              <tbody>
                {data.context.map((row) => (
                  <tr key={row.host} className="border-t border-border/70 tabular-nums">
                    <td className="py-1.5">{agentName(row.host)}</td>
                    <td>{row.tokensPerSession === null ? '—' : count(row.tokensPerSession)}</td>
                    <td>{row.tokensPerPrompt === null ? '—' : count(row.tokensPerPrompt)}</td>
                    <td>{count(row.tokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>

      <Card aria-label="What memory cost to write">
        <CardTitle action={<Info label="writing cost">Kinfold asks a model to turn what happened in a session into memories and summaries. These are the tokens those calls used, where the model's service reports them.</Info>}>What writing memories cost</CardTitle>
        <p className="text-sm">{runs === 0 ? `No summaries were written in ${period}.` : `${count(observerTokens)} tokens over ${plural(runs, 'summary run', 'summary runs')}${reported < runs ? ` (${count(reported)} of them reported their usage)` : ''}.`}</p>
        <p className="mt-1 text-sm text-muted">Search indexing made {plural(data.embedding.calls, 'call', 'calls')} for {plural(data.embedding.texts, 'memory', 'memories')}.</p>
        {data.countingSince !== null ? <p className="mt-2 text-xs text-muted">Kinfold has counted these since {dateOnly(data.countingSince)}.</p> : null}
      </Card>

      <ImpactTest />
    </div>
  )
}

function ImpactTest() {
  const client = useQueryClient()
  const { hubOnly, hub } = useHubOnly()
  const display = useQuery({ queryKey: ['/data/display'], queryFn: () => get<Display>('/data/display') })
  const save = useMutation({
    mutationFn: (holdout: boolean) => api<Display>('PUT', '/data/display', { holdout }),
    onSuccess: (next) => {
      client.setQueryData(['/data/display'], next)
      void client.invalidateQueries({ queryKey: ['/memory/impact'] })
    },
  })
  const agents = display.data === undefined || display.data.holdoutHosts.length === 0 ? 'agents whose usage Kinfold can read' : display.data.holdoutHosts.map(agentName).join(', ')
  return (
    <Card aria-label="Impact test" id="impact-test">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[0.95rem] font-semibold tracking-tight"><label htmlFor="impact-switch">Impact test</label></h2>
          <p id="impact-help" className="mt-1 text-sm leading-relaxed text-muted">
            Leaves memory out of about 1 prompt in 10 for {agents}, and the agent says so each time. While it is on, Kinfold reads only the token counts from the agent's transcript. Every other agent keeps full memory.
          </p>
          {hubOnly ? <p className="mt-1 text-xs text-muted">This switch is this device's own; the results come from {hub}.</p> : null}
        </div>
        {display.data !== undefined ? <Switch id="impact-switch" aria-describedby="impact-help" checked={display.data.holdout} disabled={save.isPending} onCheckedChange={(next) => save.mutate(next)} /> : <Skeleton className="h-5 w-9" />}
      </div>
      {save.isError ? <Notice tone="bad" className="mt-3">{errorText(save.error)}</Notice> : null}
    </Card>
  )
}
