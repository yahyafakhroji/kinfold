// The sign-in step. `kinfold dashboard` opens the login page at
// /dashboard/login#claim=<secret>, and the page claims the sign-in the running
// command offered by sending that secret (POST /dashboard/claim): the daemon
// holds only its SHA-256, so no other local program can take the session.
// `kinfold dashboard --print` links to /dashboard/login#code=<code> instead. A
// fragment is never sent in a request or a Referer. Either secret is read,
// removed from the address bar and history at once, and traded for the
// session cookie. The page at its plain address has nothing to trade and says
// how to open the dashboard. An open page whose command ended lands here as
// #closed.

export type LoginOutcome = 'signed-in' | 'closed' | 'how-to-open' | 'bad-link' | 'no-answer'

function fromHash(hash: string, name: string): string | null {
  const value = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get(name)
  return value === null || value === '' ? null : value
}

export const codeFromHash = (hash: string): string | null => fromHash(hash, 'code')
export const claimFromHash = (hash: string): string | null => fromHash(hash, 'claim')

export interface LoginDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  hash: string
  /** Clears the fragment from the address bar and history. */
  forget: () => void
}

export async function signIn(deps: LoginDeps): Promise<LoginOutcome> {
  const code = codeFromHash(deps.hash)
  const claim = claimFromHash(deps.hash)
  const closed = deps.hash === '#closed'
  deps.forget()
  if (closed) return 'closed'
  if (code === null && claim === null) return 'how-to-open'
  const [path, body] = code === null ? ['/dashboard/claim', { claim }] : ['/dashboard/session', { code }]
  try {
    const response = await deps.fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-sam-request': '1' }, body: JSON.stringify(body) })
    return response.status === 204 ? 'signed-in' : 'bad-link'
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
