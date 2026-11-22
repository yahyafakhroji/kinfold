// Response headers the daemon puts on every answer, dashboard pages and API
// alike. The CSP allows our own scripts and styles only (no inline code, no
// web fonts, no frames), so a stored title that smuggles markup has nothing
// to run even if it ever reached the DOM as HTML. No CORS header is ever set.

/** The only cache-control a route may set and keep (dashboard/routes.ts sets it on content-hashed files); every other answer is no-store. */
export const IMMUTABLE_ASSET_CACHE = 'private, max-age=31536000, immutable'

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/** A copy of the response with the security headers set and any CORS header dropped. */
export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers)
  for (const name of [...headers.keys()]) if (name.startsWith('access-control-')) headers.delete(name)
  // One exception to no-store: a built file under a content-hashed name, which the route marks itself.
  const keepCache = headers.get('cache-control') === IMMUTABLE_ASSET_CACHE
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) if (!(keepCache && name === 'cache-control')) headers.set(name, value)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
