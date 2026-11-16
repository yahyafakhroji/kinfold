// The embedders a daemon core runs with, from the store's embedding settings.
// The target writes the chosen space. While a switch builds that space, search
// stays on the active one, so its embedder runs too when it is the local
// model. A user who leaves OpenRouter has chosen to keep text on the machine,
// so queries are not sent there during the build, and a local LLM the user
// left has no address in the settings. For both, search falls back to
// keywords until the new space is complete.

import type { Database } from '../sqlite/types'
import { activeSpace } from '../store/vector-spaces'
import { EmbedError, type Embedder, createOpenRouterEmbedder } from './embedder'
import { ensureEmbeddingSettings, spaceForSettings } from './embedding-settings'
import { type LocalEmbedder, localModelPaths, startLocalEmbedder } from './local-embedder'
import { createLocalLlmEmbedder } from './local-llm-embedder'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_ID } from './local-model'

export interface EmbedderSet {
  /** Writes the configured space; null when it cannot run (no key, no length). */
  target: Embedder | null
  /** Embedders of other spaces search may still read while the target is built. */
  others: Embedder[]
  /** Why target is null. */
  reason: string
  /** Ends any worker the set started. */
  close?: () => Promise<void>
}

export type LocalStart = (signal: AbortSignal) => Promise<{ ok: true; embedder: LocalEmbedder; ms: number } | { ok: false; reason: string }>

export interface EmbedderDeps {
  /** The OpenRouter key, null when there is none; a read error counts as none. */
  openRouterKey: () => string | null
  startLocal?: LocalStart
}

export const NO_OPENROUTER_KEY = 'no OpenRouter key in the keychain for embeddings'

const defaultStartLocal: LocalStart = async (signal) => {
  const paths = localModelPaths()
  return paths.ok ? startLocalEmbedder({ paths: paths.paths, signal }) : { ok: false, reason: paths.reason }
}

/** The local model as an Embedder at once; its worker loads in the background and the first calls wait for it. */
function lazyLocal(start: LocalStart): { embedder: Embedder; close: () => Promise<void> } {
  const loading = new AbortController()
  const starting = start(loading.signal).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : 'the local model did not load' }))
  return {
    embedder: {
      model: LOCAL_MODEL_ID,
      dims: LOCAL_MODEL_DIMS,
      embed: async (texts, signal, purpose) => {
        const started = await starting
        if (!started.ok) throw new EmbedError('unavailable', started.reason)
        return started.embedder.embed(texts, signal, purpose)
      },
    },
    close: async () => {
      loading.abort()
      const started = await starting
      if (started.ok) await started.embedder.close()
    },
  }
}

function readKey(deps: EmbedderDeps): string | null {
  try {
    return deps.openRouterKey()
  } catch {
    return null
  }
}

export function embeddersFor(db: Database, deps: EmbedderDeps, now: number): EmbedderSet {
  const settings = ensureEmbeddingSettings(db, now)
  const startLocal = deps.startLocal ?? defaultStartLocal
  let local: { embedder: Embedder; close: () => Promise<void> } | null = null
  const localEmbedder = (): Embedder => {
    local ??= lazyLocal(startLocal)
    return local.embedder
  }
  const openRouter = (): Embedder | null => {
    const apiKey = readKey(deps)
    return apiKey === null ? null : createOpenRouterEmbedder({ apiKey, rereadKey: () => readKey(deps) })
  }

  let target: Embedder | null = null
  let reason = ''
  if (settings.provider === 'local') target = localEmbedder()
  else if (settings.provider === 'openrouter') {
    target = openRouter()
    if (target === null) reason = NO_OPENROUTER_KEY
  } else {
    const space = spaceForSettings(settings)
    if (space === null || settings.llmUrl === null || settings.llmModel === null) reason = 'the local LLM setting has no vector length; save it again'
    else {
      try {
        target = createLocalLlmEmbedder({ url: settings.llmUrl, model: settings.llmModel, dims: space.dims })
      } catch (error: unknown) {
        // A stored address that fails the check costs semantic search, never the daemon.
        reason = error instanceof Error ? error.message : 'the local LLM setting cannot be used'
      }
    }
  }

  const others: Embedder[] = []
  const active = activeSpace(db)
  const searchesElsewhere = active !== null && (target === null || active.model !== target.model || active.dims !== target.dims)
  if (searchesElsewhere && active.model === LOCAL_MODEL_ID && active.dims === LOCAL_MODEL_DIMS) others.push(localEmbedder())
  return { target, others, reason, close: async () => local?.close() }
}
