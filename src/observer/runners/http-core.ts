// The one HTTP path every API observer takes: a POST with a timeout, a cap on
// the answer's size, and failures named by status or error name. A key goes
// only into the headers the caller builds; no detail written here quotes a
// header, the request or the answer.

import { ObserverError } from '../types'

export const DEFAULT_HTTP_TIMEOUT_MS = 120_000
/** Far above any observer answer (30 observations at their field limits), so only a runaway or hostile server reaches it. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

export interface JsonPost {
  fetch: FetchFn
  url: string
  headers: Record<string, string>
  body: unknown
  timeoutMs: number
  /** Names the provider in error details, such as "openrouter answered 401". */
  label: string
}

function requestFailure(error: unknown): ObserverError {
  const name = error instanceof Error ? error.name : 'unknown error'
  return new ObserverError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'http_error', `request failed (${name})`)
}

/** Reads at most MAX_RESPONSE_BYTES, so a huge answer is refused without being held in memory. */
async function cappedText(response: Response, label: string): Promise<string> {
  const tooLarge = new ObserverError('bad_response', `${label} body is larger than ${MAX_RESPONSE_BYTES} bytes`)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw tooLarge
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {})
      throw tooLarge
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export async function postJson(request: JsonPost): Promise<unknown> {
  let response: Response
  try {
    response = await request.fetch(request.url, {
      method: 'POST',
      headers: { ...request.headers, 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs),
      // The endpoint was checked (https, or this machine); a redirect could name one that was not, so none is followed.
      redirect: 'error',
    })
  } catch (error: unknown) {
    throw requestFailure(error)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new ObserverError('http_error', `${request.label} answered ${response.status}`)
  }
  let text: string
  try {
    text = await cappedText(response, request.label)
  } catch (error: unknown) {
    throw error instanceof ObserverError ? error : requestFailure(error)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ObserverError('bad_response', `${request.label} body is not JSON`)
  }
}
