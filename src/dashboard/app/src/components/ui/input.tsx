import type { ComponentProps } from 'react'
import { cn } from '../../lib/cn'

const FIELD = 'h-9 rounded-md border border-border bg-surface px-3 text-sm text-text placeholder:text-muted/80 focus-visible:border-ring'

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(FIELD, 'w-full', className)} {...props} />
}

/** A native select: keyboard and screen reader support come with it, and it costs nothing in the bundle. */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(FIELD, 'pr-8', className)} {...props} />
}
