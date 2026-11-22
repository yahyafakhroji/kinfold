import { Link, Outlet } from '@tanstack/react-router'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api, errorText, watchClosed } from '../lib/api'
import { type ThemeChoice, followSystem, readTheme, saveTheme } from '../lib/theme'
import { useCentral, useUpdate } from '../lib/queries'
import { Button } from './ui/button'
import { Notice } from './ui/notice'

const PAGES = [
  { to: '/', label: 'Overview' },
  { to: '/sessions', label: 'Sessions' },
  { to: '/memory', label: 'Memory' },
  { to: '/activity', label: 'Activity' },
  { to: '/impact', label: 'Impact' },
  { to: '/settings', label: 'Settings' },
  { to: '/backup', label: 'Backup' },
] as const

const THEMES: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'Match the system', Icon: Monitor },
]

function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme)
  const next = THEMES[(THEMES.findIndex((theme) => theme.value === choice) + 1) % THEMES.length]!
  const current = THEMES.find((theme) => theme.value === choice)!
  return (
    <Button variant="ghost" size="icon" aria-label={`Theme: ${current.label}. Switch to ${next.label.toLowerCase()}`} title={`Theme: ${current.label}`} onClick={() => { saveTheme(next.value); setChoice(next.value) }}>
      <current.Icon aria-hidden="true" className="h-4 w-4" />
    </Button>
  )
}

function Where() {
  const central = useCentral().data
  if (central === undefined || central.role === 'local') return <span className="hidden text-xs text-muted sm:inline">on this computer</span>
  if (central.role === 'hub') return <span className="hidden text-xs text-muted sm:inline">hub for {central.devices.length === 1 ? '1 device' : `${central.devices.length} devices`}</span>
  return <span className="hidden text-xs text-muted sm:inline">using memory on {central.hub}</span>
}

function UpdateBanner() {
  const notice = useUpdate().data?.notice ?? null
  if (notice === null) return null
  return (
    <div className="mx-auto max-w-6xl px-4 pt-3 sm:px-6">
      <Notice tone="info">
        {notice.message} <Link to="/settings" hash="updates" className="font-medium text-accent underline-offset-4 hover:underline">See the update</Link>
      </Notice>
    </div>
  )
}

export function AppShell() {
  const [signOutError, setSignOutError] = useState<string | null>(null)
  useEffect(() => watchClosed(), [])
  useEffect(() => followSystem(), [])
  const signOut = (): void => {
    api('POST', '/dashboard/logout').then(() => location.assign('/dashboard/login'), (error: unknown) => setSignOutError(errorText(error)))
  }
  return (
    <div className="min-h-dvh">
      <a href="#main" onClick={(event) => { event.preventDefault(); document.getElementById('main')?.focus() }} className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">Skip to content</a>
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 px-4 sm:flex-nowrap sm:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2 py-3 font-semibold tracking-tight">
            <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-md bg-accent text-[0.65rem] font-bold text-surface">KF</span>
            Kinfold
          </Link>
          <Where />
          <nav aria-label="Dashboard pages" className="order-last -mb-px flex w-full min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] sm:order-none sm:w-auto sm:flex-1">
            {PAGES.map((page) => (
              <Link
                key={page.to}
                to={page.to}
                activeOptions={{ exact: page.to === '/' }}
                className="border-b-2 border-transparent px-2.5 py-3.5 text-sm whitespace-nowrap text-muted hover:text-text data-[status=active]:border-text data-[status=active]:font-medium data-[status=active]:text-text"
              >
                {page.label}
              </Link>
            ))}
          </nav>
          <span className="ml-auto sm:ml-0"><ThemeToggle /></span>
          <Button variant="ghost" size="sm" onClick={signOut}>Sign out</Button>
        </div>
      </header>
      <UpdateBanner />
      {signOutError !== null ? <div className="mx-auto max-w-6xl px-4 pt-3 sm:px-6"><Notice tone="bad">{signOutError}</Notice></div> : null}
      <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-muted sm:px-6">What your coding agents recorded, shown as plain text.</footer>
    </div>
  )
}
