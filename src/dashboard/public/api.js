// The page's one way to reach the daemon. Requests are same-origin, carry
// the session cookie (HttpOnly, so this script never sees it) and the
// X-SAM-Request header that every state-changing cookie request needs. The
// daemon token is never in the page. A 401 means the session ended (12 h,
// sign-out, or a daemon restart), so the page goes back to the login screen.

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

/**
 * One request and its answer: a 401 goes back to the login screen, any other
 * failure throws the daemon's own error text.
 * @param {string} path
 * @param {RequestInit} init
 * @returns {Promise<unknown>}
 */
async function request(path, init) {
  let response
  try {
    response = await fetch(path, init)
  } catch {
    throw new ApiError(0, 'the daemon did not answer; is it running?')
  }
  if (response.status === 401 && path !== '/dashboard/session') {
    location.assign('/dashboard/login')
    throw new ApiError(401, 'signed out')
  }
  const parsed = response.status === 204 ? null : await response.json().catch(() => null)
  if (!response.ok) {
    const message = parsed !== null && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string' ? parsed.error : `request failed (${response.status})`
    throw new ApiError(response.status, message)
  }
  return parsed
}

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
export function api(method, path, body) {
  const headers = { 'x-sam-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }
  return request(path, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
}

/**
 * Posts a file as the request body, as it is: the browser streams it, so a
 * large backup is never held in this page's memory.
 * @param {string} path
 * @param {Blob} file
 * @returns {Promise<unknown>}
 */
export function uploadFile(path, file) {
  return request(path, { method: 'POST', headers: { 'x-sam-request': '1', 'content-type': 'application/octet-stream' }, credentials: 'same-origin', body: file })
}

/** @param {unknown} error */
export function errorText(error) {
  return error instanceof Error ? error.message : 'something went wrong'
}

/**
 * The update banner's text and the release it is about, or null when there is
 * no banner or the daemon cannot say.
 * @returns {Promise<{ message: string, release: unknown, install: unknown } | null>}
 */
export async function fetchUpdate() {
  try {
    const answer = await api('GET', '/update')
    if (answer === null || typeof answer !== 'object') return null
    const found = 'notice' in answer ? answer.notice : null
    if (found === null || typeof found !== 'object' || !('message' in found) || typeof found.message !== 'string') return null
    return { message: found.message, release: 'release' in answer ? answer.release : null, install: 'install' in answer ? answer.install : null }
  } catch {
    return null
  }
}
