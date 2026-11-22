// Which embedder makes Kinfold's vectors: the bundled local model (the
// default), OpenRouter, or a local LLM server's OpenAI-style /embeddings
// endpoint. Stored in embedding_settings (v14), one row. A store with no row
// gets its default once, at the daemon's first start: OpenRouter when the
// store already has OpenRouter vectors (so they keep working until the user
// switches), the local model otherwise, even with an OpenRouter key, which may
// be there only for the observer. A local LLM must answer on this machine:
// the address is checked as loopback here, on every save and on every use.

import type { Parsed } from '../context/types'
import { isRecord } from '../contract/event'
import type { Database } from '../sqlite/types'
import type { VectorSpace } from '../store/vector-store'
import { DEFAULT_EMBED_DIMS, DEFAULT_EMBED_MODEL } from './embedder'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_ID } from './local-model'

export const EMBEDDING_PROVIDERS = ['local', 'openrouter', 'local-llm'] as const
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number]

export interface EmbeddingSettings {
  provider: EmbeddingProvider
  /** local-llm only: the server's base address, such as http://127.0.0.1:11434/v1. */
  llmUrl: string | null
  llmModel: string | null
  /** local-llm only: the vector length, learned from the server when the setting is saved. */
  llmDims: number | null
}

export const LOCAL_LLM_PREFIX = 'local-llm/'
export const MAX_LLM_DIMS = 8192
const MAX_MODEL_CHARS = 200
const MAX_URL_CHARS = 500

export const LOCAL_SETTINGS: EmbeddingSettings = { provider: 'local', llmUrl: null, llmModel: null, llmDims: null }

interface Row {
  provider: EmbeddingProvider
  llmUrl: string | null
  llmModel: string | null
  llmDims: number | null
}

export function readEmbeddingSettings(db: Database): EmbeddingSettings | null {
  return db.query<Row, []>('SELECT provider, llm_url AS llmUrl, llm_model AS llmModel, llm_dims AS llmDims FROM embedding_settings WHERE id = 1').get() ?? null
}

export function writeEmbeddingSettings(db: Database, settings: EmbeddingSettings, now: number): void {
  db.query(
    `INSERT INTO embedding_settings (id, provider, llm_url, llm_model, llm_dims, updated_at) VALUES (1, $provider, $url, $model, $dims, $now)
     ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, llm_url = excluded.llm_url, llm_model = excluded.llm_model,
       llm_dims = excluded.llm_dims, updated_at = excluded.updated_at`,
  ).run({ provider: settings.provider, url: settings.llmUrl, model: settings.llmModel, dims: settings.llmDims, now })
}

/** The saved choice, or the default for this store, saved so it holds until the user switches. */
export function ensureEmbeddingSettings(db: Database, now: number): EmbeddingSettings {
  const saved = readEmbeddingSettings(db)
  if (saved !== null) return saved
  const openRouterRows = db.query<{ n: number }, { model: string }>('SELECT count(*) AS n FROM (SELECT 1 FROM observation_vectors WHERE model = $model LIMIT 1)').get({ model: DEFAULT_EMBED_MODEL })?.n ?? 0
  const settings: EmbeddingSettings = openRouterRows > 0 ? { ...LOCAL_SETTINGS, provider: 'openrouter' } : LOCAL_SETTINGS
  writeEmbeddingSettings(db, settings, now)
  return settings
}

/** The space the settings embed into; null for a local LLM whose length is not known yet. */
export function spaceForSettings(settings: EmbeddingSettings): VectorSpace | null {
  if (settings.provider === 'local') return { model: LOCAL_MODEL_ID, dims: LOCAL_MODEL_DIMS }
  if (settings.provider === 'openrouter') return { model: DEFAULT_EMBED_MODEL, dims: DEFAULT_EMBED_DIMS }
  if (settings.llmModel === null || settings.llmDims === null) return null
  return { model: `${LOCAL_LLM_PREFIX}${settings.llmModel}`, dims: settings.llmDims }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

const isLoopbackV4 = (host: string): boolean => {
  const parts = host.split('.')
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * http(s) on 127.0.0.0/8, localhost or ::1, with no user name or password and
 * no query or fragment: /embeddings is added to the path, and the address is
 * named in errors and logs, where a `?api_key=` would be a secret.
 */
export function isLoopbackUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '' || value.includes('?') || value.includes('#')) return false
  const host = url.hostname
  return host === 'localhost' || host === '[::1]' || isLoopbackV4(host)
}

/** The /embeddings endpoint under a base address, added once. */
export function llmEndpoint(base: string): string {
  const trimmed = base.replace(/\/+$/, '')
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

/** A PUT body. Errors name the field and never echo its value. */
export function parseEmbeddingSettings(body: unknown): Parsed<EmbeddingSettings> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  const provider = body.provider
  if (!(EMBEDDING_PROVIDERS as readonly unknown[]).includes(provider)) return { ok: false, error: `provider must be one of ${EMBEDDING_PROVIDERS.join(', ')}` }
  if (provider !== 'local-llm') return { ok: true, value: { ...LOCAL_SETTINGS, provider: provider as EmbeddingProvider } }
  const { llmUrl, llmModel, llmDims } = body
  if (typeof llmUrl !== 'string' || llmUrl.length > MAX_URL_CHARS || !isLoopbackUrl(llmUrl)) {
    return { ok: false, error: 'llmUrl must be an http address on this machine (127.0.0.1, localhost or ::1)' }
  }
  // The model names the vector space in the daemon log, so it may not carry a line break or another control character.
  if (typeof llmModel !== 'string' || llmModel.trim() === '' || llmModel.length > MAX_MODEL_CHARS || CONTROL_CHARS.test(llmModel)) return { ok: false, error: 'llmModel must be a non-empty model name' }
  if (llmDims !== undefined && llmDims !== null && !(Number.isInteger(llmDims) && (llmDims as number) >= 1 && (llmDims as number) <= MAX_LLM_DIMS)) {
    return { ok: false, error: `llmDims must be an integer from 1 to ${MAX_LLM_DIMS}` }
  }
  return { ok: true, value: { provider: 'local-llm', llmUrl, llmModel: llmModel.trim(), llmDims: (llmDims as number | null | undefined) ?? null } }
}
