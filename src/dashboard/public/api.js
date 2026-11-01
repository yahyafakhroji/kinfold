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
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
export async function api(method, path, body) {
  const headers = { 'x-sam-request': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }
  let response
  try {
    response = await fetch(path, { method, headers, credentials: 'same-origin', ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
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

/** @param {unknown} error */
export function errorText(error) {
  return error instanceof Error ? error.message : 'something went wrong'
}
