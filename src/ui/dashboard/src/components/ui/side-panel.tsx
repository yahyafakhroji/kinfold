import { X } from 'lucide-react'
import { Dialog } from 'radix-ui'
import type { ReactNode } from 'react'

export interface SidePanelProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  subtitle?: ReactNode
  /** Shown beside the close button, such as "Open full page". */
  actions?: ReactNode
  children: ReactNode
}

/**
 * The detail beside a list. Non-modal on purpose: the list stays usable and
 * scrollable next to it, and a modal dialog's scroll lock would need an
 * inline <style>, which the dashboard's CSP refuses. Esc closes it and focus
 * goes back to the row that opened it.
 */
export function SidePanel({ open, onClose, title, subtitle, actions, children }: SidePanelProps) {
  return (
    <Dialog.Root open={open} modal={false} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Content
          onInteractOutside={(event) => event.preventDefault()}
          className="animate-panel-in fixed inset-y-0 right-0 z-40 flex w-full max-w-[min(46rem,100vw)] flex-col border-l border-border bg-surface shadow-[-12px_0_32px_-12px_rgb(0_0_0/0.18)] sm:w-[48%]"
        >
          <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold">{title}</Dialog.Title>
              {subtitle !== undefined ? <Dialog.Description className="mt-0.5 text-sm text-muted">{subtitle}</Dialog.Description> : <Dialog.Description className="sr-only">Details</Dialog.Description>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {actions}
              <Dialog.Close aria-label="Close" className="inline-flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-text">
                <X aria-hidden="true" className="h-4 w-4" />
              </Dialog.Close>
            </div>
          </header>
          <div data-scroll className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
