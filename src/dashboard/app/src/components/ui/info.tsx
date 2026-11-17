import { Info as InfoIcon } from 'lucide-react'
import { Popover } from 'radix-ui'
import type { ReactNode } from 'react'

/** The ⓘ beside a number: one plain sentence on what it means, opened by click or keyboard. */
export function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger aria-label={`About ${label}`} className="inline-flex h-5 w-5 cursor-pointer items-center justify-center rounded-full align-middle text-muted hover:text-text">
        <InfoIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content side="top" align="start" sideOffset={6} className="animate-fade-in z-50 max-w-72 rounded-lg border border-border bg-surface p-3 text-sm leading-relaxed text-text shadow-lg">
          {children}
          <Popover.Arrow className="fill-surface" />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
