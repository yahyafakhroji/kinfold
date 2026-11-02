// Embeddings through OpenRouter's OpenAI-compatible API (the user chose
// openai/text-embedding-3-small). The observer already sends this text to
// OpenRouter, so no new party sees it. 512 dimensions instead of 1536: the
// text-embedding-3 models are trained to be shortened, and a row is 2 KB
// instead of 6 KB. The key is passed in from the keychain and only goes into
// the Authorization header; errors carry an HTTP status or an error name,
// never a body, which could echo the input. A 401 re-reads the key once, so a
// key replaced in the keychain takes effect without a daemon restart.

import { isRecord } from '../contract/event'
import { CLI_NAME } from '../names'

export const OPENROUTER_EMBEDDINGS_ENDPOINT = 'https://openrouter.ai/api/v1/embeddings'
export const DEFAULT_EMBED_MODEL = 'openai/text-embedding-3-small'
export const DEFAULT_EMBED_DIMS = 512
export const DEFAULT_EMBED_TIMEOUT_MS = 30_000
const HTTP_UNAUTHORIZED = 401
/** After a 401 whose re-read found no new key, the next re-read waits this long. */
export const REREAD_COOLDOWN_MS = 60_000

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export type EmbedErrorKind = 'timeout' | 'http_error' | 'bad_response'

export class EmbedError extends Error {
  constructor(readonly kind: EmbedErrorKind, message: string) {
    super(message)
    this.name = 'EmbedError'
  }
}

export interface Embedder {
  model: string
  dims: number
  /** One vector per input, in input order. A caller's signal cuts the call short (the search deadline). */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]>
}

export interface OpenRouterEmbedderOptions {
  apiKey: string
  /** Reads the key again after a 401; a different key is adopted and the call retried once. */
  rereadKey?: () => string | null
  model?: string
  dims?: number
  fetch?: FetchFn
  timeoutMs?: number
  /** Wall ms, for the re-read cooldown. */
  now?: () => number
}

/** data[i].embedding as float32, placed by data[i].index; every vector must have `dims` numbers. */
export function parseEmbeddings(value: unknown, count: number, dims: number): Float32Array[] {
  if (!isRecord(value) || !Array.isArray(value.data)) throw new EmbedError('bad_response', 'response has no data')
  const out: (Float32Array | undefined)[] = new Array(count).fill(undefined)
  value.data.forEach((item: unknown, position: number) => {
    if (!isRecord(item) || !Array.isArray(item.embedding)) throw new EmbedError('bad_response', 'an item has no embedding array')
    const index = typeof item.index === 'number' ? item.index : position
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new EmbedError('bad_response', 'an item index is out of range')
    const numbers = item.embedding as unknown[]
    if (numbers.length !== dims || !numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new EmbedError('bad_response', `an embedding has ${numbers.length} values, not ${dims} finite numbers`)
    }
    out[index] = Float32Array.from(numbers as number[])
  })
  if (out.some((vector) => vector === undefined)) throw new EmbedError('bad_response', `expected ${count} embeddings`)
  return out as Float32Array[]
}

function failure(error: unknown): EmbedError {
  const name = error instanceof Error ? error.name : 'unknown error'
  return new EmbedError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'http_error', `request failed (${name})`)
}

export function createOpenRouterEmbedder(options: OpenRouterEmbedderOptions): Embedder {
  const fetchFn = options.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))
  const model = options.model ?? DEFAULT_EMBED_MODEL
  const dims = options.dims ?? DEFAULT_EMBED_DIMS
  let apiKey = options.apiKey
  const clock = options.now ?? Date.now
  /** No keychain read before this: the read is a synchronous spawn, and a revoked key would pay it on every embed. */
  let rereadAfter = 0

  /** A new key from the keychain, or null when it is unchanged, missing or unreadable; then none is read for REREAD_COOLDOWN_MS. */
  const replacementKey = (): string | null => {
    if (options.rereadKey === undefined || clock() < rereadAfter) return null
    let next: string | null
    try {
      next = options.rereadKey()
    } catch {
      next = null
    }
    if (next !== null && next !== apiKey) return next
    rereadAfter = clock() + REREAD_COOLDOWN_MS
    return null
  }

  const post = async (texts: readonly string[], signal: AbortSignal): Promise<Response> => {
    try {
      return await fetchFn(OPENROUTER_EMBEDDINGS_ENDPOINT, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'x-title': CLI_NAME },
        body: JSON.stringify({ model, input: texts, dimensions: dims, encoding_format: 'float' }),
        signal,
      })
    } catch (error: unknown) {
      throw failure(error)
    }
  }

  const embed = async (texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> => {
    if (texts.length === 0) return []
    const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS)
    const combined = signal === undefined ? timeout : AbortSignal.any([timeout, signal])
    let response = await post(texts, combined)
    if (response.status === HTTP_UNAUTHORIZED) {
      const next = replacementKey()
      if (next !== null) {
        apiKey = next
        await response.body?.cancel().catch(() => {})
        response = await post(texts, combined)
      }
    }
    if (!response.ok) throw new EmbedError('http_error', `openrouter answered ${response.status}`)
    let body: unknown
    try {
      body = await response.json()
    } catch (error: unknown) {
      throw error instanceof Error && error.name === 'AbortError' ? failure(error) : new EmbedError('bad_response', 'openrouter body is not JSON')
    }
    return parseEmbeddings(body, texts.length, dims)
  }
  return { model, dims, embed }
}
