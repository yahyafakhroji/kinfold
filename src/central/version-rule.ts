// Hub and devices must run the same major.minor; patches may differ. When
// they do not, the side to update is the older one.

import { compareVersions, parseVersion } from '../update/version-order'

export interface VersionGap {
  older: 'hub' | 'device'
  hub: string
  device: string
}

/** Null when `device` and `hub` may talk; otherwise which side is older. */
export function versionGap(device: string, hub: string): VersionGap | null {
  const mine = parseVersion(device)
  const theirs = parseVersion(hub)
  if (mine === null) return { older: 'device', hub, device }
  if (theirs === null) return { older: 'hub', hub, device }
  if (mine.major === theirs.major && mine.minor === theirs.minor) return null
  return { older: compareVersions(device, hub) < 0 ? 'device' : 'hub', hub, device }
}

/** The line a device shows while the versions differ. */
export function gapLine(gap: VersionGap): string {
  return gap.older === 'device'
    ? `the hub runs Kinfold ${gap.hub} and this device ${gap.device}; update this device (kinfold update)`
    : `the hub runs Kinfold ${gap.hub} and this device ${gap.device}; update the hub (kinfold update on the hub)`
}
