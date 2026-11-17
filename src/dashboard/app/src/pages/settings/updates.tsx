// Updates: how Kinfold updates itself, and the release on offer with its
// changes and an Install button. An install restarts the daemon; the page
// follows it through /update/install and /health and reloads once the new
// version answers, or says why it did not.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Select } from '../../components/ui/input'
import { Notice } from '../../components/ui/notice'
import { Skeleton } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { api, errorText, get } from '../../lib/api'
import { dateOnly } from '../../lib/format'
import type { UpdateView } from '../../lib/types'
import { Field, Section } from './section'

interface AutoUpdate {
  on: boolean
  reason: string | null
  lastError: { version: string; at: number; reason: string; blocked?: true } | null
  lastUpdate: { version: string; previous: string; at: number } | null
}

const LEVELS = [
  { value: 'off', label: 'Off', help: 'Kinfold never checks for releases.' },
  { value: 'notify', label: 'Tell me', help: 'Kinfold checks once a day and tells you here when a release is out.' },
  { value: 'patch', label: 'Install fixes, offer the rest', help: 'Bug-fix releases install themselves when your agents are quiet. Larger releases are downloaded and wait for you to press Install.' },
] as const

const POLL_MS = 2_000
const GIVE_UP_MS = 20 * 60_000

interface Health {
  version: string
  pid: number
}

async function health(): Promise<Health | null> {
  try {
    const response = await fetch('/health', { cache: 'no-store' })
    const body = response.ok ? ((await response.json()) as Partial<Health>) : null
    return typeof body?.version === 'string' && typeof body.pid === 'number' ? { version: body.version, pid: body.pid } : null
  } catch {
    return null
  }
}

type InstallRun = NonNullable<UpdateView['install']>

export interface InstallDeps {
  health: () => Promise<Health | null>
  state: () => Promise<InstallRun | null>
  sleep: (ms: number) => Promise<void>
}

const LIVE: InstallDeps = {
  health,
  // Read without api(): while the daemon restarts, a read can meet a 401 before `kinfold dashboard`
  // renews its lease, and api() would leave for the closed screen in the middle of a good install.
  state: async () => {
    try {
      const response = await fetch('/update/install', { credentials: 'same-origin', cache: 'no-store' })
      return response.ok ? ((await response.json()) as { install: InstallRun | null }).install : null
    } catch {
      return null
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/** Follows an install until the new version answers; resolves with what to tell the reader. */
export async function followInstall(version: string, before: Health | null, deps: InstallDeps = LIVE): Promise<{ ok: boolean; message: string }> {
  for (let waited = 0; waited < GIVE_UP_MS; waited += POLL_MS) {
    await deps.sleep(POLL_MS)
    const run = await deps.state()
    if (run !== null && run.version === version && run.state === 'failed') return { ok: false, message: `The install did not finish: ${run.message ?? 'see logs/auto-update.log in the Kinfold data folder'}.` }
    const now = await deps.health()
    if (now === null) continue
    if (now.version === version) return { ok: true, message: `Kinfold ${version} is installed. Reloading…` }
    if (before !== null && now.pid !== before.pid) return { ok: false, message: `The install did not finish; Kinfold is still ${now.version}. Run kinfold update in a terminal to see why.` }
  }
  return { ok: false, message: 'Kinfold has not come back yet. Run kinfold status in a terminal to see where the install is.' }
}

function Release({ release }: { release: NonNullable<UpdateView['release']> }) {
  const [progress, setProgress] = useState<{ tone: 'info' | 'good' | 'bad'; text: string } | null>(null)
  const install = useMutation({
    mutationFn: async () => {
      const before = await health()
      await api('POST', '/update/install', { version: release.version })
      setProgress({ tone: 'info', text: `Installing Kinfold ${release.version}. Kinfold restarts to finish; this page reloads when it is back.` })
      const result = await followInstall(release.version, before)
      setProgress({ tone: result.ok ? 'good' : 'bad', text: result.message })
      if (result.ok) location.reload()
    },
  })
  const breaking = new Set(release.breaking)
  return (
    <div className="space-y-3 rounded-lg border border-border p-4">
      <p className="font-medium">Kinfold {release.version} is {release.staged ? 'downloaded and ready' : 'out'}.</p>
      {release.changes.length === 0 ? <p className="text-sm text-muted">This release has no list of changes.</p> : (
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {release.changes.map((line) => <li key={line}>{breaking.has(line) ? <Badge tone="warn" className="mr-1.5">Changes how something works</Badge> : null}{line.replace(/^BREAKING:\s*/, '')}</li>)}
        </ul>
      )}
      {release.installable ? <Button variant="primary" size="sm" disabled={install.isPending} onClick={() => install.mutate()}>Install {release.version}</Button> : <p className="text-sm text-muted">Install it with kinfold update in a terminal.</p>}
      {progress !== null ? <Notice tone={progress.tone}>{progress.text}</Notice> : null}
      {install.isError ? <Notice tone="bad">{errorText(install.error)}</Notice> : null}
    </div>
  )
}

export function UpdatesSection() {
  const client = useQueryClient()
  const update = useQuery({ queryKey: ['/update'], queryFn: () => get<UpdateView>('/update') })
  const auto = useQuery({ queryKey: ['/update/auto'], queryFn: () => get<{ auto: AutoUpdate }>('/update/auto') })
  const save = useMutation({
    mutationFn: (settings: { level: string; beta: boolean }) => api('PUT', '/update/settings', settings),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['/update'] })
      void client.invalidateQueries({ queryKey: ['/update/auto'] })
    },
  })
  const settings = update.data?.settings
  const level = LEVELS.find((entry) => entry.value === settings?.level) ?? LEVELS[1]
  const view = auto.data?.auto
  return (
    <Section id="updates" title="Updates" intro="How Kinfold keeps itself up to date. Nothing installs while your agents are working.">
      {update.isError ? <Notice tone="bad">{errorText(update.error)}</Notice> : null}
      {settings === undefined ? (update.data !== undefined ? <p className="text-sm text-muted">Update settings live in Kinfold's install record; run kinfold install to create one.</p> : <Skeleton className="h-16 w-full" />) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Updates" htmlFor="update-level" help={level.help}>
            <Select id="update-level" className="w-full" value={settings.level} disabled={save.isPending} onChange={(event) => save.mutate({ level: event.target.value, beta: settings.beta })}>
              {LEVELS.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
            </Select>
          </Field>
          <div className="space-y-1">
            <div className="flex items-center gap-3 pt-6">
              <Switch id="update-beta" checked={settings.beta} disabled={save.isPending || settings.level === 'off'} onCheckedChange={(beta) => save.mutate({ level: settings.level, beta })} aria-describedby="update-beta-help" />
              <label htmlFor="update-beta" className="text-sm font-medium">Beta releases</label>
            </div>
            <p id="update-beta-help" className="text-xs text-muted">Get releases before they are final. They may have rough edges.</p>
          </div>
        </div>
      )}
      {view !== undefined ? (
        <div className="space-y-1 text-sm">
          <p>{view.on ? 'Bug-fix releases install themselves here.' : `Bug-fix releases do not install themselves here${view.reason !== null ? `: ${view.reason}` : ''}.`}</p>
          {view.lastUpdate !== null ? <p className="text-muted">Last update: {view.lastUpdate.previous} to {view.lastUpdate.version} on {dateOnly(view.lastUpdate.at)}.</p> : null}
          {view.lastError !== null ? <Notice tone="bad">The update to {view.lastError.version} on {dateOnly(view.lastError.at)} did not finish: {view.lastError.reason}{view.lastError.blocked === true ? ' Kinfold will not try again until this changes.' : ''}</Notice> : null}
        </div>
      ) : null}
      {update.data?.release !== null && update.data?.release !== undefined ? <Release release={update.data.release} /> : update.data !== undefined ? <p className="text-sm text-muted">You are on the latest release.</p> : null}
      {save.isError ? <Notice tone="bad">{errorText(save.error)}</Notice> : null}
    </Section>
  )
}
