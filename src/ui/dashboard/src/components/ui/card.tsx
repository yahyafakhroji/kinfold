import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '../../lib/cn'

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cn('rounded-xl border border-border bg-surface p-5 shadow-[0_1px_0_0_var(--border)]', className)} {...props} />
}

export function CardTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex items-baseline justify-between gap-3', className)}>
      <h2 className="text-[0.95rem] font-semibold tracking-tight">{children}</h2>
      {action}
    </div>
  )
}
