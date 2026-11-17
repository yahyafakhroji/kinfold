import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ago } from '../lib/format'

export function PageHeader({ title, children, aside }: { title: string; children?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {children !== undefined ? <p className="mt-1.5 leading-relaxed text-muted">{children}</p> : null}
      </div>
      {aside}
    </header>
  )
}

/** "Updated 3 min ago" for a report the daemon keeps, and that a newer one is on its way. */
export function AsOf({ at, refreshing }: { at: number; refreshing: boolean }) {
  return <p className="text-xs text-muted" aria-live="polite">Figures as of {ago(at)}{refreshing ? '; newer ones are on their way' : ''}.</p>
}

export function NotFound() {
  return (
    <div className="py-16 text-center">
      <h1 className="text-xl font-semibold">This page does not exist</h1>
      <p className="mt-2 text-muted"><Link to="/" className="text-accent underline-offset-4 hover:underline">Go to the overview</Link></p>
    </div>
  )
}
