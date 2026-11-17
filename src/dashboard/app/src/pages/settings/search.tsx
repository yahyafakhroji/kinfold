// Search: what turns memories into vectors so agents can find them by
// meaning. Each choice is its own index; switching builds the new one in the
// background and search keeps the old one until it is done.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Notice } from '../../components/ui/notice'
import { Skeleton } from '../../components/ui/skeleton'
import { api, errorText, get } from '../../lib/api'
import { count } from '../../lib/format'
import { useHubOnly } from '../../lib/queries'
import { Field, HubOnlyNote, Section } from './section'

interface Space {
  model: string
  dims: number
  indexed: number
  pending: number
  vecReady: boolean
}

interface EmbeddingView {
  settings: { provider: 'local' | 'openrouter' | 'local-llm'; llmUrl: string | null; llmModel: string | null; llmDims: number | null } | null
  active: Space | null
  building: Space | null
  lastError: string | null
}

const DESCRIBE: Readonly<Record<string, string>> = {
  local: 'The built-in model, on this computer. Free, and no memory text leaves it.',
  openrouter: 'OpenRouter, with your OpenRouter key. Memory text is sent to OpenRouter.',
  'local-llm': 'A model served on this computer, such as Ollama.',
}

export function SearchSection() {
  const client = useQueryClient()
  const { hubOnly, hub } = useHubOnly()
  const view = useQuery({ queryKey: ['/embedding/settings'], queryFn: () => get<EmbeddingView>('/embedding/settings'), refetchInterval: (query) => (query.state.data?.building !== null ? 5_000 : false) })
  const [llmUrl, setLlmUrl] = useState<string | null>(null)
  const [llmModel, setLlmModel] = useState<string | null>(null)
  const save = useMutation({ mutationFn: (body: unknown) => api('PUT', '/embedding/settings', body), onSuccess: () => void client.invalidateQueries({ queryKey: ['/embedding/settings'] }) })
  const data = view.data
  const current = data?.settings?.provider ?? null
  const url = llmUrl ?? data?.settings?.llmUrl ?? 'http://127.0.0.1:11434/v1'
  const model = llmModel ?? data?.settings?.llmModel ?? 'nomic-embed-text'
  return (
    <Section id="search" title="Search" intro="Agents find memory by its words and by its meaning. Finding by meaning needs every memory turned into numbers (a vector); this is the model that does it.">
      {hubOnly ? <HubOnlyNote hub={hub} /> : null}
      {view.isError ? <Notice tone="bad">{errorText(view.error)}</Notice> : null}
      {data === undefined ? <Skeleton className="h-24 w-full" /> : (
        <>
          <p className="text-sm">{current === null ? 'Not chosen yet. Kinfold picks the built-in model the next time it starts.' : `${DESCRIBE[current] ?? current}${current === 'local-llm' ? ` (${data.settings?.llmModel ?? ''} at ${data.settings?.llmUrl ?? ''})` : ''}`}</p>
          {data.active !== null ? <p className="text-sm text-muted">{count(data.active.indexed)} of {count(data.active.indexed + data.active.pending)} memories can be found by meaning.</p> : null}
          {data.building !== null ? <Notice>Switching to {data.building.model}: {count(data.building.indexed)} of {count(data.building.indexed + data.building.pending)} done. Search keeps the current model until then.</Notice> : null}
          {data.lastError !== null ? <Notice tone="bad">The last indexing attempt failed: {data.lastError}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            {current !== 'local' ? <Button size="sm" disabled={hubOnly || save.isPending} onClick={() => save.mutate({ provider: 'local' })}>Use the built-in model</Button> : null}
            {current !== 'openrouter' ? <Button size="sm" disabled={hubOnly || save.isPending} onClick={() => save.mutate({ provider: 'openrouter' })}>Use OpenRouter</Button> : null}
          </div>
          <form className="grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end" onSubmit={(event) => { event.preventDefault(); save.mutate({ provider: 'local-llm', llmUrl: url.trim(), llmModel: model.trim() }) }}>
            <Field label="Local model server" htmlFor="llm-url" help="Must answer on this computer; Kinfold checks it before saving.">
              <Input id="llm-url" type="url" className="font-mono" value={url} disabled={hubOnly} onChange={(event) => setLlmUrl(event.target.value)} />
            </Field>
            <Field label="Embedding model" htmlFor="llm-model">
              <Input id="llm-model" className="font-mono" value={model} disabled={hubOnly} onChange={(event) => setLlmModel(event.target.value)} />
            </Field>
            <Button type="submit" size="md" disabled={hubOnly || save.isPending}>Use this server</Button>
          </form>
          {save.isSuccess ? <Notice tone="good">Saved. Kinfold builds the new index in the background and switches search over when every memory has a vector.</Notice> : null}
          {save.isError ? <Notice tone="bad">{errorText(save.error)}</Notice> : null}
        </>
      )}
    </Section>
  )
}
