// Embeddings from a local LLM server's OpenAI-style /embeddings endpoint
// (Ollama, LM Studio and the like). Opt in only. The address must be loopback,
// checked when the embedder is made, and a redirect is refused, so the text
// never leaves this machine. No key is sent. Errors carry a status or an error
// name, never a body, which could echo the input.

import { EmbedError, type Embedder, type FetchFn, parseEmbeddings } from './embedder'
import { LOCAL_LLM_PREFIX, isLoopbackUrl, llmEndpoint } from './embedding-settings'

export const LOCAL_LLM_TIMEOUT_MS = 60_000
const PROBE_TEXT = 'Kinfold embedding check'

export interface LocalLlmOptions {
  url: string
  model: string
  dims: number
  fetch?: FetchFn
  timeoutMs?: number
}

const name = (error: unknown): string => (error instanceof Error ? error.name : 'error')

async function post(fetchFn: FetchFn, endpoint: string, model: string, texts: readonly string[], signal: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: texts, encoding_format: 'float' }),
      redirect: 'error',
      signal,
    })
  } catch (error: unknown) {
    const kind = name(error) === 'TimeoutError' || name(error) === 'AbortError' ? 'timeout' : 'http_error'
    throw new EmbedError(kind, `the local LLM did not answer at ${endpoint} (${name(error)})`)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new EmbedError('http_error', `the local LLM answered ${response.status}`)
  }
  try {
    return await response.json()
  } catch {
    throw new EmbedError('bad_response', 'the local LLM body is not JSON')
  }
}

export function createLocalLlmEmbedder(options: LocalLlmOptions): Embedder {
  if (!isLoopbackUrl(options.url)) throw new Error('the local LLM address must be loopback')
  const endpoint = llmEndpoint(options.url)
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  return {
    model: `${LOCAL_LLM_PREFIX}${options.model}`,
    dims: options.dims,
    embed: async (texts, signal) => {
      if (texts.length === 0) return []
      const timeout = AbortSignal.timeout(options.timeoutMs ?? LOCAL_LLM_TIMEOUT_MS)
      const body = await post(fetchFn, endpoint, options.model, texts, signal === undefined ? timeout : AbortSignal.any([timeout, signal]))
      return parseEmbeddings(body, texts.length, options.dims)
    },
  }
}

/** One fixed text, to learn the server's vector length when the setting is saved. */
export async function probeLocalLlmDims(options: Omit<LocalLlmOptions, 'dims'>): Promise<{ ok: true; dims: number } | { ok: false; reason: string }> {
  if (!isLoopbackUrl(options.url)) return { ok: false, reason: 'the local LLM address must be loopback' }
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  try {
    const body = await post(fetchFn, llmEndpoint(options.url), options.model, [PROBE_TEXT], AbortSignal.timeout(options.timeoutMs ?? LOCAL_LLM_TIMEOUT_MS))
    const first = (body as { data?: { embedding?: unknown }[] }).data?.[0]?.embedding
    if (!Array.isArray(first) || first.length === 0 || first.length > 8192) return { ok: false, reason: 'the local LLM answered no usable embedding' }
    return { ok: true, dims: first.length }
  } catch (error: unknown) {
    return { ok: false, reason: error instanceof Error ? error.message : 'the local LLM check failed' }
  }
}
