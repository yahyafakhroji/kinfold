// The sign-in step, as #47 defined it. `kinfold dashboard` opens the login
// page at its plain address and the page claims the sign-in the running
// command offered (POST /dashboard/claim). `kinfold dashboard --print` links to
// /dashboard/login#code=<code> instead; a fragment is never sent in a request
// or a Referer. The code is read, removed from the address bar and history at
// once, and traded for the session cookie (POST /dashboard/session). An open
// page whose command ended lands here as #closed.

export type LoginOutcome = 'signed-in' | 'closed' | 'how-to-open' | 'bad-link' | 'no-answer'

export function codeFromHash(hash: string): string | null {
  const code = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('code')
  return code === null || code === '' ? null : code
}

export interface LoginDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  hash: string
  /** Clears the fragment from the address bar and history. */
  forget: () => void
}

export async function signIn(deps: LoginDeps): Promise<LoginOutcome> {
  const code = codeFromHash(deps.hash)
  const closed = deps.hash === '#closed'
  deps.forget()
  if (closed) return 'closed'
  try {
    const response = code === null
      ? await deps.fetch('/dashboard/claim', { method: 'POST', credentials: 'same-origin', headers: { 'x-sam-request': '1' } })
      : await deps.fetch('/dashboard/session', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sam-request': '1' }, body: JSON.stringify({ code }) })
    if (response.status === 204) return 'signed-in'
    return code === null ? 'how-to-open' : 'bad-link'
  } catch {
    return 'no-answer'
  }
}

export const LOGIN_MESSAGES: Readonly<Record<Exclude<LoginOutcome, 'signed-in'>, string>> = {
  closed: 'The dashboard closed. Run kinfold dashboard in a terminal to open it again.',
  'how-to-open': 'The dashboard is open while kinfold dashboard runs in a terminal. Run it: it opens this page signed in, and Ctrl-C closes it.',
  'bad-link': 'This sign-in link is wrong, used or expired, or the dashboard closed. Run kinfold dashboard in a terminal to open it.',
  'no-answer': 'Kinfold did not answer. Is it running?',
}
