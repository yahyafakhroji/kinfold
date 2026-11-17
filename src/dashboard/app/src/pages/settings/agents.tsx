// Agents and summaries: which model turns each agent's sessions into memory.
// One form per agent, plus the default every agent without its own uses. A
// test sends one short fixed prompt to the chosen model and says whether it
// answered; no reply text and no key ever reach the page.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { Input, Select } from '../../components/ui/input'
import { Notice } from '../../components/ui/notice'
import { Skeleton } from '../../components/ui/skeleton'
import { Switch } from '../../components/ui/switch'
import { problemText } from '../../lib/activity'
import { api, errorText, get } from '../../lib/api'
import { agentName } from '../../lib/format'
import { useHubOnly } from '../../lib/queries'
import { Field, HubOnlyNote, Section } from './section'

/** The daemon's observer providers, in its order. */
export const PROVIDERS: readonly { value: string; label: string }[] = [
  { value: 'claude-cli', label: 'Claude Code CLI' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'codex-cli', label: 'Codex CLI' },
  { value: 'opencode-cli', label: 'OpenCode CLI' },
  { value: 'goose-cli', label: 'Goose CLI' },
  { value: 'anthropic-api', label: 'Anthropic API' },
  { value: 'openai-api', label: 'OpenAI API' },
  { value: 'gemini-api', label: 'Gemini API' },
  { value: 'qwen-api', label: 'Qwen API (DashScope)' },
  { value: 'openai-compatible', label: 'OpenAI-compatible server' },
]
const CLI_MODEL_LISTS = new Set(['codex-cli', 'opencode-cli'])
const KEY_ENTRIES: Readonly<Record<string, string>> = { openrouter: 'openrouter', 'anthropic-api': 'anthropic', 'openai-api': 'openai', 'gemini-api': 'gemini', 'qwen-api': 'dashscope', 'openai-compatible': 'none (a local server)' }
const ENDPOINTS: Readonly<Record<string, string>> = { 'qwen-api': 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'openai-compatible': 'http://127.0.0.1:11434/v1' }

interface Choice {
  provider: string
  model: string
  credentialRef: string | null
  enabled: boolean
  endpoint?: string
  source?: 'host' | 'default-row' | 'built-in'
}

export interface SettingsView {
  rows: (Choice & { host: string })[]
  effective: ({ host: string; settings: Choice } | { host: string; error: string })[]
  safety?: { provider: string; status: string; errorClass: string | null }[]
  probe?: { provider: string; errorClass: string }[]
  backoff?: { provider: string; line: string }[]
}

interface Entry {
  host: string
  choice: Choice | null
  problem: string | null
}

export function hostEntries(view: SettingsView): Entry[] {
  const star = view.rows.find((row) => row.host === '*') ?? null
  const hosts = view.effective.map((entry): Entry => ('settings' in entry
    ? { host: entry.host, choice: entry.settings, problem: null }
    : { host: entry.host, choice: view.rows.find((row) => row.host === entry.host) ?? null, problem: entry.error }))
  return [...hosts, { host: '*', choice: star === null ? null : { ...star, source: 'host' }, problem: null }]
}

const SOURCE_SHORT: Readonly<Record<string, string>> = { host: 'set for this agent', 'default-row': 'from the default', 'built-in': 'built-in default' }

function hasWarning(view: SettingsView, provider: string): boolean {
  return (view.safety ?? []).some((row) => row.provider === provider && row.status === 'failed') || (view.probe ?? []).some((row) => row.provider === provider) || (view.backoff ?? []).some((row) => row.provider === provider)
}

function Warnings({ view, provider }: { view: SettingsView; provider: string }) {
  const client = useQueryClient()
  const stopped = view.safety?.find((row) => row.provider === provider && row.status === 'failed') ?? null
  const unprobed = view.probe?.find((row) => row.provider === provider) ?? null
  const backoff = view.backoff?.find((row) => row.provider === provider) ?? null
  const recheck = useMutation({ mutationFn: () => api('POST', '/observer/recheck', { provider }), onSuccess: () => void client.invalidateQueries({ queryKey: ['/observer/settings'] }) })
  return (
    <>
      {unprobed !== null ? <Notice tone="bad">Summaries are not running: Kinfold could not start this tool ({problemText(unprobed.errorClass)}). Install it or sign in to it; Kinfold tries again on its own.</Notice> : null}
      {backoff !== null ? <Notice tone="bad">Summaries keep failing and Kinfold is waiting before it tries again. {backoff.line}</Notice> : null}
      {stopped !== null ? (
        <Notice tone="bad">
          {stopped.errorClass === 'safety_check_failed'
            ? 'This model failed Kinfold\'s safety check (it followed an instruction hidden in the test text), so summaries are stopped. Choose another model or tool, then check again.'
            : `Summaries are stopped: the safety check could not run (${problemText(stopped.errorClass)}). Fix that, then check again.`}
          <div className="mt-2">
            {recheck.isSuccess ? <span className="text-muted">Queued. The next batch runs the check again, within a minute.</span> : <Button size="sm" disabled={recheck.isPending} onClick={() => recheck.mutate()}>Check again</Button>}
          </div>
          {recheck.isError ? <p className="mt-1 text-bad">{errorText(recheck.error)}</p> : null}
        </Notice>
      ) : null}
    </>
  )
}

function ModelNames({ id, provider }: { id: string; provider: string }) {
  const models = useQuery({
    queryKey: ['/observer/models', provider],
    queryFn: () => get<{ ok: boolean; models?: string[] }>(`/observer/models?provider=${encodeURIComponent(provider)}`),
    enabled: CLI_MODEL_LISTS.has(provider),
    staleTime: 10 * 60_000,
  })
  return <datalist id={id}>{(models.data?.ok === true ? models.data.models ?? [] : []).map((name) => <option key={name} value={name} />)}</datalist>
}

function AgentForm({ entry, view, disabled }: { entry: Entry; view: SettingsView; disabled: boolean }) {
  const base = useId()
  const client = useQueryClient()
  const start = entry.choice ?? { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true }
  const [form, setForm] = useState({ provider: start.provider, model: start.model, credentialRef: start.credentialRef ?? '', endpoint: start.endpoint ?? '', enabled: start.enabled })
  const body = { host: entry.host, provider: form.provider, model: form.model.trim(), enabled: form.enabled, credentialRef: form.credentialRef.trim() === '' ? null : form.credentialRef.trim(), ...(form.endpoint.trim() === '' ? {} : { endpoint: form.endpoint.trim() }) }
  const save = useMutation({ mutationFn: () => api('PUT', '/observer/settings', body), onSuccess: () => void client.invalidateQueries({ queryKey: ['/observer/settings'] }) })
  const test = useMutation({ mutationFn: () => api<{ ok: boolean; errorClass?: string }>('POST', '/observer/test', body) })
  const title = entry.host === '*' ? 'Default for every other agent' : agentName(entry.host)
  const service = PROVIDERS.find((provider) => provider.value === start.provider)?.label ?? start.provider
  const troubled = entry.problem !== null || hasWarning(view, start.provider)
  return (
    <details open={troubled} className="group border-t border-border first:border-0">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3 hover:bg-surface-2/60">
        <span className="font-medium">{title}{troubled ? <Badge tone="bad" className="ml-2">Needs a look</Badge> : null}</span>
        <span className="text-sm text-muted">{start.enabled ? `${service} · ${start.model}` : 'Not writing memories'}<span className="ml-2 text-xs">{entry.choice === null ? 'built-in default' : SOURCE_SHORT[entry.choice.source ?? 'host'] ?? ''}</span></span>
      </summary>
    <form className="space-y-4 pb-5" onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
      {entry.problem !== null ? <Notice tone="bad">This agent's setting cannot be used: {entry.problem}</Notice> : null}
      <Warnings view={view} provider={form.provider} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Model service" htmlFor={`${base}-provider`} help="Where Kinfold sends a finished session to be summarized.">
          <Select id={`${base}-provider`} className="w-full" value={form.provider} disabled={disabled} onChange={(event) => setForm({ ...form, provider: event.target.value })}>
            {PROVIDERS.map((provider) => <option key={provider.value} value={provider.value}>{provider.label}</option>)}
          </Select>
        </Field>
        <Field label="Model" htmlFor={`${base}-model`} help="The model's name as the service knows it. Small, fast models work well.">
          <Input id={`${base}-model`} list={`${base}-models`} className="font-mono" required maxLength={200} autoComplete="off" spellCheck={false} value={form.model} disabled={disabled} onChange={(event) => setForm({ ...form, model: event.target.value })} />
          <ModelNames id={`${base}-models`} provider={form.provider} />
        </Field>
        {Object.hasOwn(ENDPOINTS, form.provider) ? (
          <Field label="Address" htmlFor={`${base}-endpoint`} help="The service's address. Leave it empty for the usual one.">
            <Input id={`${base}-endpoint`} className="font-mono" inputMode="url" maxLength={500} placeholder={ENDPOINTS[form.provider]} autoComplete="off" spellCheck={false} value={form.endpoint} disabled={disabled} onChange={(event) => setForm({ ...form, endpoint: event.target.value })} />
          </Field>
        ) : null}
        {Object.hasOwn(KEY_ENTRIES, form.provider) ? (
          <Field label="Key name in the keychain" htmlFor={`${base}-key`} help="Which saved key to use. Leave it empty for the usual name. The key itself never comes to this page.">
            <Input id={`${base}-key`} className="font-mono" maxLength={64} placeholder={KEY_ENTRIES[form.provider]} autoComplete="off" spellCheck={false} value={form.credentialRef} disabled={disabled} onChange={(event) => setForm({ ...form, credentialRef: event.target.value })} />
          </Field>
        ) : null}
      </div>
      <div className="flex items-center gap-3">
        <Switch id={`${base}-enabled`} checked={form.enabled} disabled={disabled} onCheckedChange={(enabled) => setForm({ ...form, enabled })} aria-describedby={`${base}-enabled-help`} />
        <label htmlFor={`${base}-enabled`} className="text-sm">Write memories for this agent</label>
      </div>
      <p id={`${base}-enabled-help`} className="-mt-3 text-xs text-muted">When off, sessions are still recorded but nothing new is learned from them.</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={disabled || save.isPending}>Save</Button>
        <Button size="sm" disabled={disabled || test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test this model'}</Button>
        <span aria-live="polite" className="text-sm">
          {save.isSuccess ? <span className="text-good">Saved. It applies from the next session summary.</span> : null}
          {test.data?.ok === true ? <Badge tone="good">The model answered</Badge> : null}
          {test.data !== undefined && test.data.ok !== true ? <span className="text-bad">The test failed: {problemText(test.data.errorClass ?? null)}.</span> : null}
        </span>
      </div>
      {save.isError ? <Notice tone="bad">{errorText(save.error)}</Notice> : null}
      {test.isError ? <Notice tone="bad">{errorText(test.error)}</Notice> : null}
    </form>
    </details>
  )
}

export function AgentsSection() {
  const { hubOnly, hub } = useHubOnly()
  const view = useQuery({ queryKey: ['/observer/settings'], queryFn: () => get<SettingsView>('/observer/settings') })
  return (
    <Section id="agents" title="Agents and summaries" intro="After each session, Kinfold asks a model to write down what is worth remembering. Choose which model does that for each agent; open an agent to change it. If the model fails, the session waits and nothing is lost.">
      {hubOnly ? <HubOnlyNote hub={hub} /> : null}
      {view.isError ? <Notice tone="bad">{errorText(view.error)}</Notice> : null}
      {view.data === undefined ? <Skeleton className="h-40 w-full" /> : <div>{hostEntries(view.data).map((entry) => <AgentForm key={entry.host} entry={entry} view={view.data} disabled={hubOnly} />)}</div>}
    </Section>
  )
}
