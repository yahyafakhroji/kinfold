import { StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { LOGIN_MESSAGES, type LoginOutcome, signIn } from './lib/login'
import { applyTheme, readTheme } from './lib/theme'
import './styles.css'

applyTheme(readTheme())

// Read before React renders anything, so the code leaves the address bar at once.
const attempt = signIn({ fetch: (input, init) => fetch(input, init), hash: location.hash, forget: () => history.replaceState(null, '', '/dashboard/login') })

function Login() {
  const [outcome, setOutcome] = useState<LoginOutcome | null>(null)
  useEffect(() => {
    void attempt.then((result) => {
      if (result === 'signed-in') location.replace('/dashboard/')
      else setOutcome(result)
    })
  }, [])
  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-7 text-center shadow-sm">
        <span aria-hidden="true" className="mx-auto mb-3 grid h-9 w-9 place-items-center rounded-lg bg-accent text-xs font-bold text-surface">KF</span>
        <h1 className="text-lg font-semibold">Kinfold</h1>
        <p role="status" className="mt-3 text-sm leading-relaxed text-muted">{outcome === null || outcome === 'signed-in' ? 'Signing in…' : LOGIN_MESSAGES[outcome]}</p>
        <p className="mt-4 text-xs text-muted">The dashboard runs only on this computer.</p>
      </div>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Login /></StrictMode>)
