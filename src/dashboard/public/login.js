// The login page. `sam dashboard` opens /dashboard/login#code=<code>; a
// fragment is never sent in a request or a Referer. This script reads the
// code, removes it from the address bar and history at once, and trades it
// for a session cookie through POST /dashboard/session. The code works once,
// within 60 s; afterwards the page only explains how to get a new link.

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
    say('This login link is wrong, used or expired. Run `sam dashboard` in a terminal for a new one.', 'error')
  } catch {
    say('The daemon did not answer. Is it running?', 'error')
  }
}

const code = codeFromHash(location.hash)
history.replaceState(null, '', '/dashboard/login')
if (code === null) say('Open the dashboard with `sam dashboard` in a terminal. It opens a one-time link that signs you in.', 'quiet')
else login(code)
