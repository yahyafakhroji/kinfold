// Privacy: whether agents show you what was recalled, and leak findings:
// stored text that today's secret rules would hide. A finding's value is
// never shown; it can be hidden in place or its row removed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Notice } from '../../components/ui/notice'
import { Skeleton } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { api, errorText, get } from '../../lib/api'
import { ago, count } from '../../lib/format'
import { useHubOnly } from '../../lib/queries'
import { HubOnlyNote, Section } from './section'

interface Display {
  showRecall: boolean
  holdout: boolean
  holdoutHosts: string[]
}

interface Finding {
  id: number
  rule: string
  table: string
  rowId: string
  field: string | null
  foundAt: number
  matches: number
  action: string
}

const WHERE: Readonly<Record<string, string>> = { events: 'a captured event', prompts: 'a prompt', observations: 'a memory', summaries: 'a summary' }

function RecallLine() {
  const client = useQueryClient()
  const display = useQuery({ queryKey: ['/data/display'], queryFn: () => get<Display>('/data/display') })
  const save = useMutation({ mutationFn: (showRecall: boolean) => api<Display>('PUT', '/data/display', { showRecall }), onSuccess: (next) => client.setQueryData(['/data/display'], next) })
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor="recall-line" className="text-sm font-medium">Show what Kinfold recalled</label>
        <p id="recall-line-help" className="mt-0.5 text-xs leading-relaxed text-muted">Agents that can show a message say which memories they were given after each prompt. Only you see it; it never enters the model's context.</p>
        {save.isError ? <p className="mt-1 text-sm text-bad">{errorText(save.error)}</p> : null}
      </div>
      {display.data !== undefined ? <Switch id="recall-line" aria-describedby="recall-line-help" checked={display.data.showRecall} disabled={save.isPending} onCheckedChange={(next) => save.mutate(next)} /> : <Skeleton className="h-5 w-9" />}
    </div>
  )
}

function Findings({ disabled }: { disabled: boolean }) {
  const client = useQueryClient()
  const findings = useQuery({ queryKey: ['/data/findings'], queryFn: () => get<{ findings: Finding[]; pendingByRule: Record<string, number> }>('/data/findings?action=pending') })
  const reload = (): void => void client.invalidateQueries({ queryKey: ['/data/findings'] })
  const scan = useMutation({ mutationFn: () => api('POST', '/data/scan', {}), onSuccess: reload })
  const resolve = useMutation({ mutationFn: ({ id, action }: { id: number; action: 'redact' | 'purge' }) => api('POST', `/data/findings/${id}/resolve`, { action }), onSuccess: reload })
  const [armed, setArmed] = useState<number | null>(null)
  const rows = findings.data?.findings ?? []
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">Leak findings</h3>
        <Button size="sm" disabled={disabled || scan.isPending} onClick={() => scan.mutate()}>{scan.isPending ? 'Checking…' : 'Check stored text now'}</Button>
      </div>
      <p className="text-xs leading-relaxed text-muted">Kinfold hides secrets before it stores anything. When its rules improve, it checks older text again and lists anything the new rules would hide. The value itself is never shown here.</p>
      {findings.isError ? <Notice tone="bad">{errorText(findings.error)}</Notice> : null}
      {findings.data === undefined ? <Skeleton className="h-12 w-full" /> : rows.length === 0 ? <p className="text-sm text-good">Nothing found. Stored text passes today's rules.</p> : (
        <ul className="divide-y divide-border/70 text-sm">
          {rows.map((finding) => (
            <li key={finding.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span>Something that looks like <span className="font-mono">{finding.rule}</span> in {WHERE[finding.table] ?? finding.table}{finding.matches > 1 ? `, ${count(finding.matches)} times` : ''}, found {ago(finding.foundAt)}</span>
              <span className="flex gap-2">
                <Button size="sm" disabled={disabled || resolve.isPending} onClick={() => resolve.mutate({ id: finding.id, action: 'redact' })}>Hide it</Button>
                {armed === finding.id
                  ? <Button variant="danger" size="sm" disabled={disabled || resolve.isPending} onClick={() => resolve.mutate({ id: finding.id, action: 'purge' })}>Remove it for good</Button>
                  : <Button variant="dangerQuiet" size="sm" disabled={disabled} onClick={() => setArmed(finding.id)}>Remove the record…</Button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {scan.isError || resolve.isError ? <Notice tone="bad">{errorText(scan.error ?? resolve.error)}</Notice> : null}
    </div>
  )
}

export function PrivacySection() {
  const { hubOnly, hub } = useHubOnly()
  return (
    <Section id="privacy" title="Privacy" intro="What agents show you about memory, and a check for secrets in what is already stored.">
      <RecallLine />
      {hubOnly ? <HubOnlyNote hub={hub} /> : null}
      <Findings disabled={hubOnly} />
    </Section>
  )
}
