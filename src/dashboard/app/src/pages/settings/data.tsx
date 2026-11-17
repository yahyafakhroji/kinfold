// Data and retention: how much space memory takes, how long each kind of
// record is kept, and removing records in bulk. A retention change and a
// purge both show what they would remove before anything is changed.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input, Select } from '../../components/ui/input'
import { Notice } from '../../components/ui/notice'
import { Skeleton } from '../../components/ui/skeleton'
import { api, errorText, get } from '../../lib/api'
import { bytes, count } from '../../lib/format'
import { describeCounts } from '../../lib/purge'
import { useFacets, useHubOnly } from '../../lib/queries'
import { Field, HubOnlyNote, Section } from './section'

type Table = 'events' | 'prompts' | 'observations' | 'summaries'
const TABLES: readonly { table: Table; label: string; help: string }[] = [
  { table: 'events', label: 'Captured events', help: 'The raw record of each tool call and reply, used to write memories. Kinfold keeps 30 days unless you change it.' },
  { table: 'prompts', label: 'Prompts and replies', help: 'What you asked and what the agent answered, shown on the Sessions page.' },
  { table: 'observations', label: 'Memories', help: 'What agents get recalled. Shorter means agents forget older work.' },
  { table: 'summaries', label: 'Turn summaries', help: 'A short account of each turn.' },
]

interface Settings {
  retention: Record<Table, number | null>
  warnBytes: number
}

interface Size {
  totalBytes: number
  warnBytes: number
  overWarn: boolean
  warning: string | null
  parts: { name: string; bytes: number }[]
}

const PART_NAMES: Readonly<Record<string, string>> = { prompts: 'Prompts', replies: 'Replies', events: 'Captured events', observations: 'Memories', summaries: 'Summaries', vectors: 'Search index', other: 'Everything else' }

function SizeBlock() {
  const size = useQuery({ queryKey: ['/data/size'], queryFn: () => get<Size>('/data/size'), retry: (failures, error) => failures < 5 && error instanceof Error && 'status' in error && error.status === 503, retryDelay: 3_000 })
  if (size.isError) return <Notice tone="bad">{errorText(size.error)}</Notice>
  if (size.data === undefined) return <Skeleton className="h-16 w-full" />
  const largest = Math.max(1, ...size.data.parts.map((part) => part.bytes))
  return (
    <div className="space-y-2">
      <p className="text-sm">Memory takes {bytes(size.data.totalBytes)} on disk.</p>
      {size.data.overWarn && size.data.warning !== null ? <Notice tone="warn">{size.data.warning}</Notice> : null}
      <ul className="space-y-1.5 text-sm">
        {size.data.parts.filter((part) => part.bytes > 0).map((part) => (
          <li key={part.name} className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-3">
            <span className="text-muted">{PART_NAMES[part.name] ?? part.name}</span>
            <span className="h-2 rounded-full bg-surface-2"><span className="block h-2 rounded-full bg-accent/70" style={{ width: `${Math.max(2, (part.bytes / largest) * 100)}%` }} /></span>
            <span className="text-right tabular-nums text-muted">{bytes(part.bytes)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function RetentionBlock({ disabled }: { disabled: boolean }) {
  const client = useQueryClient()
  const stored = useQuery({ queryKey: ['/data/retention'], queryFn: () => get<Settings>('/data/retention') })
  const [draft, setDraft] = useState<Record<Table, string> | null>(null)
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null)
  const values = draft ?? (stored.data === undefined ? null : Object.fromEntries(TABLES.map(({ table }) => [table, stored.data.retention[table] === null ? '' : String(stored.data.retention[table])])) as Record<Table, string>)
  const change = values === null ? null : Object.fromEntries(TABLES.map(({ table }) => [table, values[table].trim() === '' ? null : Number(values[table])])) as Record<Table, number | null>
  const key = JSON.stringify(change)
  const invalid = change !== null && Object.values(change).some((days) => days !== null && (!Number.isSafeInteger(days) || days < 1))
  const ask = useMutation({
    mutationFn: () => api<{ preview: { tables: Record<Table, { rows: number; bytes: number }> } }>('PUT', '/data/retention', { retention: change, preview: true }),
    onSuccess: (answer) => {
      const parts = TABLES.map(({ table, label }) => [label, answer.preview.tables[table]?.rows ?? 0] as const).filter(([, rows]) => rows > 0)
      setPreview({ key, text: parts.length === 0 ? 'Saving removes nothing now.' : `Saving removes, right away: ${parts.map(([label, rows]) => `${count(rows)} ${label.toLowerCase()}`).join(', ')}.` })
    },
  })
  const save = useMutation({
    mutationFn: () => api('PUT', '/data/retention', { retention: change }),
    onSuccess: () => {
      setDraft(null)
      setPreview(null)
      void client.invalidateQueries({ queryKey: ['/data/retention'] })
      void client.invalidateQueries({ queryKey: ['/data/size'] })
    },
  })
  if (values === null) return <Skeleton className="h-24 w-full" />
  return (
    <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); ask.mutate() }}>
      <h3 className="font-medium">How long to keep each kind of record</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        {TABLES.map(({ table, label, help }) => (
          <Field key={table} label={`${label} (days)`} htmlFor={`keep-${table}`} help={help}>
            <Input id={`keep-${table}`} inputMode="numeric" placeholder="Keep forever" value={values[table]} disabled={disabled} onChange={(event) => { setDraft({ ...values, [table]: event.target.value }); setPreview(null) }} />
          </Field>
        ))}
      </div>
      {invalid ? <p className="text-sm text-bad">Days must be a whole number of 1 or more, or empty to keep forever.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={disabled || invalid || ask.isPending}>See what this removes</Button>
        {preview !== null && preview.key === key ? <Button variant="primary" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button> : null}
      </div>
      {preview !== null && preview.key === key ? <p aria-live="polite" className="text-sm">{preview.text}</p> : null}
      {save.isSuccess ? <Notice tone="good">Saved and applied.</Notice> : null}
      {ask.isError || save.isError ? <Notice tone="bad">{errorText(ask.error ?? save.error)}</Notice> : null}
    </form>
  )
}

type PurgeKind = 'project' | 'host' | 'session' | 'range'

function PurgeBlock({ disabled }: { disabled: boolean }) {
  const projects = useFacets().data?.projects ?? []
  const [kind, setKind] = useState<PurgeKind>('project')
  const [value, setValue] = useState('')
  const [before, setBefore] = useState('')
  const [preview, setPreview] = useState<{ key: string; text: string } | null>(null)
  const target = ((): Record<string, string | number> | string => {
    if (kind === 'session') return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? { session: Number(value) } : 'Enter a session number.'
    if (kind === 'range') return Number.isFinite(Date.parse(before)) ? { before: new Date(Date.parse(before)).toISOString() } : 'Choose a date.'
    return value.trim() === '' ? `Choose a ${kind === 'host' ? 'agent' : 'project'}.` : { [kind]: value.trim() }
  })()
  const key = JSON.stringify(target)
  const dryRun = useMutation({
    mutationFn: () => api<{ counts: Record<string, number> }>('POST', '/data/purge', { ...(target as object), dryRun: true }),
    onSuccess: (report) => setPreview({ key, text: `This removes ${describeCounts(report.counts)}.` }),
  })
  const purge = useMutation({ mutationFn: () => api<{ counts: Record<string, number> }>('POST', '/data/purge', { ...(target as object), dryRun: false }), onSuccess: () => setPreview(null) })
  return (
    <details className="rounded-lg border border-border p-4">
      <summary className="cursor-pointer font-medium">Remove records in bulk</summary>
      <div className="mt-4 space-y-4">
        <p className="text-sm text-muted">Deletes everything for a project, an agent, a session or everything before a date: memories, prompts, summaries and their search entries. Kinfold shows what it would remove first. This cannot be undone, except by restoring a backup.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Remove by" htmlFor="purge-kind">
            <Select id="purge-kind" className="w-full" value={kind} disabled={disabled} onChange={(event) => { setKind(event.target.value as PurgeKind); setValue(''); setPreview(null) }}>
              <option value="project">Project</option><option value="host">Agent</option><option value="session">Session number</option><option value="range">Everything before a date</option>
            </Select>
          </Field>
          {kind === 'range' ? (
            <Field label="Before" htmlFor="purge-before"><Input id="purge-before" type="date" value={before} disabled={disabled} onChange={(event) => { setBefore(event.target.value); setPreview(null) }} /></Field>
          ) : kind === 'project' ? (
            <Field label="Project" htmlFor="purge-value">
              <Select id="purge-value" className="w-full" value={value} disabled={disabled} onChange={(event) => { setValue(event.target.value); setPreview(null) }}>
                <option value="">Choose a project</option>
                {projects.map((project) => <option key={project.value} value={project.value}>{project.label}</option>)}
              </Select>
            </Field>
          ) : (
            <Field label={kind === 'host' ? 'Agent (as Kinfold names it, such as claude-code)' : 'Session number'} htmlFor="purge-value"><Input id="purge-value" className="font-mono" value={value} disabled={disabled} onChange={(event) => { setValue(event.target.value); setPreview(null) }} /></Field>
          )}
        </div>
        {typeof target === 'string' ? <p className="text-xs text-muted">{target}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="dangerQuiet" size="sm" disabled={disabled || typeof target === 'string' || dryRun.isPending} onClick={() => dryRun.mutate()}>See what this removes</Button>
          {preview !== null && preview.key === key ? <Button variant="danger" size="sm" disabled={purge.isPending} onClick={() => purge.mutate()}>Remove</Button> : null}
        </div>
        {preview !== null && preview.key === key ? <p aria-live="polite" className="text-sm">{preview.text}</p> : null}
        {purge.isSuccess ? <Notice tone="good">Removed {describeCounts(purge.data.counts)}.</Notice> : null}
        {dryRun.isError || purge.isError ? <Notice tone="bad">{errorText(dryRun.error ?? purge.error)}</Notice> : null}
      </div>
    </details>
  )
}

export function DataSection() {
  const { hubOnly, hub } = useHubOnly()
  return (
    <Section id="data" title="Data and retention" intro="Everything Kinfold keeps stays on this computer. Choose how long it keeps each kind of record.">
      <SizeBlock />
      {hubOnly ? <HubOnlyNote hub={hub} /> : null}
      <RetentionBlock disabled={hubOnly} />
      <PurgeBlock disabled={hubOnly} />
    </Section>
  )
}
