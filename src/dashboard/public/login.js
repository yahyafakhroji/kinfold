// The login page. `kinfold dashboard` opens it at its plain address, and the
// page claims the sign-in the running command offered (POST /dashboard/claim).
// `kinfold dashboard --print` links to /dashboard/login#code=<code>; a
// fragment is never sent in a request or a Referer. This script reads the
// code, removes it from the address bar and history at once, and trades it
// for a session cookie through POST /dashboard/session. The code works once,
// within 60 s; afterwards the page only explains how to get a new link. An
// open page whose command ended lands here as #closed.

const message = document.getElementById('login-message')

/** @param {string} text @param {'quiet' | 'error'} tone */
function say(text, tone) {
  if (message === null) return
  message.textContent = text
  message.className = `notice notice-${tone}`
}

/** @param {string} hash */
export function codeFromHash(hash) {
  const code = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash).get('code')
  return code === null || code === '' ? null : code
}

async function login(code) {
  say('Signing in…', 'quiet')
  try {
    const response = await fetch('/dashboard/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-sam-request': '1' },
      body: JSON.stringify({ code }),
    })
    if (response.status === 204) {
      location.replace('/dashboard/')
      return
    }
    say('This login link is wrong, used or expired, or the dashboard closed. Run `kinfold dashboard` in a terminal to open it.', 'error')
  } catch {
    say('The daemon did not answer. Is it running?', 'error')
  }
}

const HOW_TO_OPEN = 'The dashboard is open while `kinfold dashboard` runs in a terminal. Run it; it opens this page signed in, and Ctrl-C closes it.'

/** The sign-in the running command offered; it has no secret to send, and only this origin's page can claim it. */
async function claim() {
  say('Signing in…', 'quiet')
  try {
    const response = await fetch('/dashboard/claim', { method: 'POST', credentials: 'same-origin', headers: { 'x-sam-request': '1' } })
    if (response.status === 204) {
      location.replace('/dashboard/')
      return
    }
    say(HOW_TO_OPEN, 'quiet')
  } catch {
    say('The daemon did not answer. Is it running?', 'error')
  }
}

const code = codeFromHash(location.hash)
const closed = location.hash === '#closed'
history.replaceState(null, '', '/dashboard/login')
if (closed) say('Dashboard closed; run `kinfold dashboard` in a terminal to open it again.', 'quiet')
else if (code === null) claim()
else login(code)
