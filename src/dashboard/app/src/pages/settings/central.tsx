// Central memory: whether this computer keeps its own memory, is the hub
// other computers share, or uses a hub's memory. Joining and leaving are done
// with `kinfold central` in a terminal, since they move keys between machines.

import { useQuery } from '@tanstack/react-query'
import { Notice } from '../../components/ui/notice'
import { Skeleton } from '../../components/ui/skeleton'
import { get } from '../../lib/api'
import { ago, dateOnly, plural } from '../../lib/format'
import { deviceNotice } from '../../lib/central'
import { useCentral } from '../../lib/queries'
import type { CentralStatus, DeviceRow } from '../../lib/types'
import { Section } from './section'

function Devices() {
  const devices = useQuery({ queryKey: ['/memory/list/devices'], queryFn: () => get<{ rows: DeviceRow[] }>('/memory/list/devices') })
  const central = useCentral().data
  const paired = central?.role === 'hub' ? central.devices : []
  const seen = new Map((devices.data?.rows ?? []).map((row) => [row.device, row]))
  if (paired.length === 0) return <p className="text-sm text-muted">No other computer has joined yet. On another computer, run kinfold central join and follow its steps.</p>
  return (
    <table className="w-full text-sm">
      <thead><tr className="text-left text-xs text-muted"><th scope="col" className="py-1 font-medium">Device</th><th scope="col" className="py-1 font-medium">Joined</th><th scope="col" className="py-1 font-medium">Sessions</th><th scope="col" className="py-1 font-medium">Last seen</th></tr></thead>
      <tbody>
        {paired.map((device) => {
          const row = seen.get(device.id)
          return (
            <tr key={device.id} className="border-t border-border/70">
              <td className="py-1.5 font-medium">{device.name}</td>
              <td>{dateOnly(device.pairedAt)}</td>
              <td className="tabular-nums">{row?.sessions ?? 0}</td>
              <td>{row?.lastSeenAt !== null && row?.lastSeenAt !== undefined ? ago(row.lastSeenAt) : 'not yet'}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function DeviceLink({ data }: { data: Extract<CentralStatus, { role: 'device' }> }) {
  const notice = deviceNotice(data)
  if (notice !== null) return <Notice tone={notice.tone}>{notice.text}</Notice>
  return <p className="text-sm text-muted">{data.lastContactAt !== null ? `Last heard from ${ago(data.lastContactAt)}.` : ''} {data.queued > 0 ? `${plural(data.queued, 'capture is', 'captures are')} waiting to be sent.` : ''}</p>
}

export function CentralSection() {
  const central = useCentral()
  const data = central.data
  return (
    <Section id="central" title="Central memory" intro="Several computers can share one memory: one computer is the hub and keeps it, the others use it over your Tailscale network. Set this up with kinfold central in a terminal.">
      {data === undefined ? <Skeleton className="h-12 w-full" /> : data.role === 'local' ? (
        <p className="text-sm">This computer keeps its own memory. To share it with your other computers, run kinfold central host here.</p>
      ) : data.role === 'hub' ? (
        <>
          <p className="text-sm">This computer is the hub{data.hubName !== null ? ` (${data.hubName})` : ''}, for {plural(data.devices.length, 'other device', 'other devices')}.{data.listening !== null ? ` Devices reach it at ${data.listening}.` : ''}</p>
          {data.error !== null ? <Notice tone="bad">Other devices cannot reach this hub: {data.error}</Notice> : null}
          <Devices />
        </>
      ) : (
        <>
          <p className="text-sm">This computer uses the memory kept on {data.hub} ({data.address}). Changes to stored memory, backups and summary settings are made there.</p>
          <DeviceLink data={data} />
        </>
      )}
    </Section>
  )
}
