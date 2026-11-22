// The page's one way to reach the daemon. Requests are same-origin, carry the
// session cookie (HttpOnly, so this code never sees it) and the X-SAM-Request
// header every state-changing cookie request needs. The daemon token never
// reaches the page. A 401 means the session ended or the dashboard closed
// (its `kinfold dashboard` command ended), so the page goes to the login
// screen, which says which.

export class ApiError extends Error {
  readonly status: number
  /** A central device refused it: the change can only be made on the hub. */
  readonly hubOnly: boolean

  constructor(status: number, message: string, hubOnly = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.hubOnly = hubOnly
  }
}

export const LOGIN_PATH = '/dashboard/login'
export const CLOSED_PATH = '/dashboard/login#closed'

/** Where a signed-out page goes; tests replace it. */
export const navigation = { assign: (path: string): void => location.assign(path) }

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

async function request<T>(path: string, init: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init })
  } catch {
    throw new ApiError(0, 'Kinfold did not answer. Is it running?')
  }
  if (response.status === 401) {
    const answer: unknown = await response.json().catch(() => null)
    const closed = isObject(answer) && answer.closed === true
    navigation.assign(closed ? CLOSED_PATH : LOGIN_PATH)
    throw new ApiError(401, closed ? 'The dashboard closed.' : 'You were signed out.')
  }
  const parsed: unknown = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const message = isObject(parsed) && typeof parsed.error === 'string' ? parsed.error : `The request failed (${response.status}).`
    throw new ApiError(response.status, message, isObject(parsed) && parsed.hubOnly === true)
  }
  return parsed as T
}

export function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'x-sam-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }
  return request<T>(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

export const get = <T>(path: string): Promise<T> => api<T>('GET', path)

/** Sends a file as the body as it is: the browser streams it, so a large backup never sits in the page's memory. */
export function uploadFile<T>(path: string, file: Blob): Promise<T> {
  return request<T>(path, { method: 'POST', headers: { 'x-sam-request': '1', 'content-type': 'application/octet-stream' }, body: file })
}

/** How soon a page left open notices that its `kinfold dashboard` ended. */
export const STATE_EVERY_MS = 5_000

/** Asks every few seconds whether the dashboard is still open; the 401 handling above does the rest. The daemon does not count these as activity. */
export function watchClosed(every: number = STATE_EVERY_MS): () => void {
  const timer = setInterval(() => {
    request('/dashboard/state', { method: 'GET' }).catch(() => {})
  }, every)
  return () => clearInterval(timer)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong.'
}

/** A query string from the values that are set; empty values are left out so a cleared filter leaves the URL. */
export function queryString(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}
