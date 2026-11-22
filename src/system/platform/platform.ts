// The one place that reads which OS this process runs on. Everything else asks
// here, or takes a platform value handed down from here, so tests can pick any
// OS and a new port has one list of OS checks to follow.

import { readFileSync } from 'node:fs'

export type OsName = 'macos' | 'linux' | 'windows'

export interface PlatformInfo {
  os: OsName
  /** Linux running under Windows Subsystem for Linux; always false on other OSes. */
  wsl: boolean
  node: NodeJS.Platform
}

export interface PlatformProbe {
  platform: NodeJS.Platform
  /** /proc/sys/kernel/osrelease, or null when it cannot be read. */
  osRelease: () => string | null
  env: Readonly<Record<string, string | undefined>>
}

const OS_NAMES: Readonly<Record<string, OsName>> = { darwin: 'macos', linux: 'linux', win32: 'windows' }

const OS_RELEASE_PATH = '/proc/sys/kernel/osrelease'

/** The OS a Node platform string names, or null for one Kinfold does not run on. */
export function osOf(platform: string): OsName | null {
  return OS_NAMES[platform] ?? null
}

/** osOf, throwing the refusal for a platform Kinfold does not run on. */
export function requireOs(platform: string): OsName {
  const os = osOf(platform)
  if (os === null) throw new Error(`kinfold runs on macOS, Linux and Windows, not ${platform}`)
  return os
}

// A probe that throws counts as "not WSL": the answer only changes hints, never
// where data goes, so guessing plain Linux is the safe side.
function isWsl(probe: PlatformProbe): boolean {
  const distro = probe.env.WSL_DISTRO_NAME
  if (distro !== undefined && distro !== '') return true
  try {
    return /microsoft/i.test(probe.osRelease() ?? '')
  } catch {
    return false
  }
}

export function detectPlatform(probe: PlatformProbe): PlatformInfo {
  const os = requireOs(probe.platform)
  return { os, wsl: os === 'linux' && isWsl(probe), node: probe.platform }
}

function readOsRelease(): string | null {
  try {
    return readFileSync(OS_RELEASE_PATH, 'utf8')
  } catch {
    return null
  }
}

let current: PlatformInfo | null = null

/** detectPlatform for this process, computed once. */
export function currentPlatform(): PlatformInfo {
  current ??= detectPlatform({ platform: process.platform, osRelease: readOsRelease, env: process.env })
  return current
}

/** The one refusal text every stub uses. */
export function notSupportedYet(label: string): string {
  return `${label}: not supported on this platform yet`
}
