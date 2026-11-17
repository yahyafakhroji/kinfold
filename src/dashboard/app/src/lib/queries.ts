// Reads several pages share. TanStack Query keeps each answer per key, so a
// page shows what it had at once and refreshes behind it.

import { useQuery } from '@tanstack/react-query'
import { get } from './api'
import type { CentralStatus, DeviceRow, Facets, Kept, Overview, UpdateView } from './types'

const MINUTE = 60_000

export function useCentral() {
  return useQuery({ queryKey: ['/central/status'], queryFn: () => get<CentralStatus>('/central/status'), staleTime: MINUTE })
}

/** On a central device, changes to stored memory are made on the hub. */
export function useHubOnly(): { hubOnly: boolean; hub: string | null } {
  const central = useCentral().data
  return central?.role === 'device' ? { hubOnly: true, hub: central.hub } : { hubOnly: false, hub: null }
}

/** Device names by id, what to call this machine, and when devices started being recorded. */
export function useDeviceNames(): { names: ReadonlyMap<string, string>; here: string | null; central: boolean; since: number | null } {
  const central = useCentral().data
  const devices = useQuery({ queryKey: ['/memory/list/devices'], queryFn: () => get<{ rows: DeviceRow[] }>('/memory/list/devices'), staleTime: 5 * MINUTE })
  const names = new Map((devices.data?.rows ?? []).filter((row) => row.name !== null).map((row) => [row.device, row.name!]))
  // On a device every row comes from the hub, so the hub's own sessions ('local' there) are the hub's.
  const here = central?.role === 'hub' ? central.hubName : central?.role === 'device' ? central.hub : null
  const seenElsewhere = (devices.data?.rows ?? []).some((row) => row.device !== 'local')
  // The overview is a report the daemon keeps, so reading its date here costs nothing extra.
  const overview = useQuery({ queryKey: ['/memory/overview'], queryFn: () => get<Kept<Overview>>('/memory/overview'), staleTime: 5 * MINUTE })
  return { names, here, central: central?.role === 'hub' || central?.role === 'device' || seenElsewhere, since: overview.data?.value.recordsSince ?? null }
}

export function useUpdate() {
  return useQuery({ queryKey: ['/update'], queryFn: () => get<UpdateView>('/update'), staleTime: 5 * MINUTE })
}

export function useFacets() {
  return useQuery({ queryKey: ['/memory/facets'], queryFn: () => get<Facets>('/memory/facets'), staleTime: 5 * MINUTE })
}
