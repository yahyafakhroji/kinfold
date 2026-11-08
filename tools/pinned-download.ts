// Downloads one pinned release asset for the build tools. The release URL is
// tried first; a server error or a timeout moves on to the pinned GitHub API
// asset URL. The bytes are checked against the pinned sha256 whichever URL
// served them, so a fallback never makes a file more trusted.

import { createHash } from 'node:crypto'

export interface PinnedDownload {
  /** Names the asset in error messages. */
  label: string
  releaseUrl: string
  apiUrl: string
  sha256: string
  maxBytes: number
  fetch?: typeof fetch
  timeoutMs?: number
  /** Sent to the API asset URL only; anonymous API calls share a rate limit and answer 403. */
  token?: string
}

const DEFAULT_TIMEOUT_MS = 60_000

class Unavailable extends Error {}

async function fetchOnce(url: string, headers: Record<string, string>, input: PinnedDownload): Promise<Uint8Array<ArrayBuffer>> {
  const doFetch = input.fetch ?? fetch
  let response: Response
  try {
    response = await doFetch(url, { redirect: 'follow', headers, signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS) })
  } catch (error) {
    throw new Unavailable(`${error instanceof Error ? error.message : String(error)}`)
  }
  if (response.status >= 500) throw new Unavailable(`answered ${response.status}`)
  if (!response.ok) throw new Error(`answered ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

function check(bytes: Uint8Array<ArrayBuffer>, input: PinnedDownload): Uint8Array<ArrayBuffer> {
  if (bytes.length > input.maxBytes) throw new Error(`the ${input.label} download is far larger than the release; nothing was written`)
  if (createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error(`the ${input.label} download does not match the pinned sha256; nothing was written`)
  return bytes
}

export async function downloadPinned(input: PinnedDownload): Promise<Uint8Array<ArrayBuffer>> {
  let releaseFailure: string
  try {
    return check(await fetchOnce(input.releaseUrl, {}, input), input)
  } catch (error) {
    if (!(error instanceof Unavailable)) throw wrap(error, input.label, 'release URL')
    releaseFailure = error.message
  }
  console.warn(`${input.label}: the release URL ${releaseFailure}; trying the API asset URL`)
  try {
    return check(await fetchOnce(input.apiUrl, { Accept: 'application/octet-stream', ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}) }, input), input)
  } catch (error) {
    if (error instanceof Unavailable) throw new Error(`the ${input.label} download failed on both URLs (release URL ${releaseFailure}; API asset URL ${error.message}); nothing was written`)
    throw wrap(error, input.label, 'API asset URL')
  }
}

function wrap(error: unknown, label: string, where: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  // Pinned-check messages already name the asset.
  return message.startsWith('the ') ? new Error(message) : new Error(`the ${label} ${where} ${message}; nothing was written`)
}
