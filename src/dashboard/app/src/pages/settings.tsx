// Settings, grouped, with each setting saying what it does in one sentence.

import { useLocation } from '@tanstack/react-router'
import { useEffect } from 'react'
import { PageHeader } from '../components/page'
import { AgentsSection } from './settings/agents'
import { CentralSection } from './settings/central'
import { DataSection } from './settings/data'
import { PrivacySection } from './settings/privacy'
import { SearchSection } from './settings/search'
import { UpdatesSection } from './settings/updates'

const SECTIONS = [
  ['agents', 'Agents and summaries'],
  ['search', 'Search'],
  ['updates', 'Updates'],
  ['central', 'Central memory'],
  ['data', 'Data and retention'],
  ['privacy', 'Privacy'],
] as const

export function SettingsPage() {
  const hash = useLocation({ select: (location) => location.hash })
  useEffect(() => {
    if (hash !== '') document.getElementById(hash)?.scrollIntoView({ block: 'start' })
  }, [hash])
  return (
    <div className="grid gap-8 lg:grid-cols-[12rem_1fr]">
      <nav aria-label="Settings sections" className="hidden lg:block">
        <ul className="sticky top-20 space-y-1 text-sm">
          {SECTIONS.map(([id, label]) => <li key={id}><a href={`#/settings#${id}`} className="block rounded-md px-2 py-1 text-muted hover:bg-surface-2 hover:text-text">{label}</a></li>)}
        </ul>
      </nav>
      <div className="min-w-0 space-y-6">
        <PageHeader title="Settings">Each setting says what it changes. Most take effect on the next prompt.</PageHeader>
        <AgentsSection />
        <SearchSection />
        <UpdatesSection />
        <CentralSection />
        <DataSection />
        <PrivacySection />
      </div>
    </div>
  )
}
