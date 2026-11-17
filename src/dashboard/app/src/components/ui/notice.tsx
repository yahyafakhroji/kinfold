import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'

const TONES = {
  info: 'border-border bg-surface-2 text-text',
  good: 'border-good/30 bg-good-soft text-text',
  warn: 'border-warn/30 bg-warn-soft text-text',
  bad: 'border-bad/30 bg-bad-soft text-text',
} as const

/** A sentence that needs to be seen: errors are alerts, everything else a polite status. */
export function Notice({ tone = 'info', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  return (
    <div role={tone === 'bad' ? 'alert' : 'status'} className={cn('rounded-lg border px-3 py-2 text-sm leading-relaxed', TONES[tone], className)}>
      {children}
    </div>
  )
}
