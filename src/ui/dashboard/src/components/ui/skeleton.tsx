import { cn } from '../../lib/cn'

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('animate-shimmer rounded-md bg-surface-2', className)} />
}
