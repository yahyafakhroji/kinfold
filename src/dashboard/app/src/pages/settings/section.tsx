import type { ReactNode } from 'react'
import { Card } from '../../components/ui/card'

export function Section({ id, title, intro, children }: { id: string; title: string; intro: string; children: ReactNode }) {
  return (
    <Card id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20">
      <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 mb-5 text-sm leading-relaxed text-muted">{intro}</p>
      <div className="space-y-6">{children}</div>
    </Card>
  )
}

/** A field with its label and the one sentence that says what it does. */
export function Field({ label, help, htmlFor, children }: { label: string; help?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {help !== undefined ? <p className="text-xs leading-relaxed text-muted">{help}</p> : null}
    </div>
  )
}

/** Shown in place of a control's effect on a central device: the setting lives on the hub. */
export function HubOnlyNote({ hub }: { hub: string | null }) {
  return <p className="text-xs text-muted">This device uses memory kept on {hub ?? 'the hub'}, so this is set there, in that computer's dashboard.</p>
}
