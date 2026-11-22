import { useId } from 'react'
import { agentName } from '../lib/format'
import { type ListSearch, withFilter } from '../lib/list-search'
import { useDeviceNames, useFacets } from '../lib/queries'
import { Select } from './ui/input'

interface FilterProps {
  search: ListSearch
  onSearch: (next: ListSearch) => void
}

function Labelled({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: React.ReactNode }) {
  const id = useId()
  return (
    <>
      <label htmlFor={id} className="sr-only">{label}</label>
      <Select id={id} value={value} onChange={(event) => onChange(event.target.value)}>{children}</Select>
    </>
  )
}

export function ProjectFilter({ search, onSearch }: FilterProps) {
  const projects = useFacets().data?.projects ?? []
  return (
    <Labelled label="Project" value={search.project ?? ''} onChange={(project) => onSearch(withFilter(search, { project }))}>
      <option value="">All projects</option>
      {projects.map((project) => <option key={project.value} value={project.value}>{project.label}</option>)}
    </Labelled>
  )
}

export function AgentFilter({ search, onSearch }: FilterProps) {
  const hosts = useFacets().data?.hosts ?? []
  return (
    <Labelled label="Agent" value={search.host ?? ''} onChange={(host) => onSearch(withFilter(search, { host }))}>
      <option value="">All agents</option>
      {hosts.map((host) => <option key={host.value} value={host.value}>{agentName(host.value)}</option>)}
    </Labelled>
  )
}

/** Shown only where there is more than one machine to tell apart. */
export function DeviceFilter({ search, onSearch }: FilterProps) {
  const { names, here, central } = useDeviceNames()
  if (!central) return null
  return (
    <Labelled label="Device" value={search.device ?? ''} onChange={(device) => onSearch(withFilter(search, { device }))}>
      <option value="">All devices</option>
      <option value="local">{here ?? 'This computer'}</option>
      {[...names].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </Labelled>
  )
}
