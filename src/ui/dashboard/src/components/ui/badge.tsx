import type { ReactNode } from 'react'
import { cn } from '../../lib/cn'
import type { Tone } from '../../lib/format'

const TONES: Record<Tone | 'warn' | 'accent', string> = {
  good: 'bg-good-soft text-good',
  quiet: 'bg-surface-2 text-muted',
  bad: 'bg-bad-soft text-bad',
  warn: 'bg-warn-soft text-warn',
  accent: 'bg-accent-soft text-accent',
}

export function Badge({ tone = 'quiet', children, className }: { tone?: keyof typeof TONES; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>{children}</span>
}
