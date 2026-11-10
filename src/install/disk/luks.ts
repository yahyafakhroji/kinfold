// The Linux (WSL included) disk check. It reads mountinfo and sysfs only, so it
// runs no command and needs no root. The data folder's own mount is what
// counts, since a home or data volume can be encrypted when / is not.

import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DiskEncryptionCheck } from './check'

export interface LuksRoots { mountinfo: string; sys: string }

export const LUKS_ADVICE = 'LUKS is set up when a disk is formatted; keep the data folder on an encrypted volume'

// LVM on LUKS is two levels deep; anything past this is a loop or a stack sysfs
// cannot describe plainly.
const MAX_DEPTH = 8

const DEVICE_PATTERN = /^\d+:\d+$/
const SLAVE_NAME_PATTERN = /^[^/\\]+$/
const CRYPT_UUID_PREFIX = 'CRYPT-'

// mountinfo escapes space, tab, newline and backslash as \ooo octal.
function decodeMountPath(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

function contains(mountPoint: string, path: string): boolean {
  if (mountPoint === '/') return path.startsWith('/')
  return path === mountPoint || path.startsWith(`${mountPoint}/`)
}

/** "major:minor" of the mount with the longest mount point containing `path`; null when none. Decodes \040-style escapes. */
export function mountDevice(mountinfo: string, path: string): string | null {
  let best: { length: number; device: string } | null = null
  for (const line of mountinfo.split('\n')) {
    const [, , device, , rawMountPoint] = line.split(' ')
    if (device === undefined || rawMountPoint === undefined || !DEVICE_PATTERN.test(device)) continue
    const mountPoint = decodeMountPath(rawMountPoint)
    if (!contains(mountPoint, path)) continue
    // >= so a later mount on the same point, which hides the earlier one, wins.
    if (best === null || mountPoint.length >= best.length) best = { length: mountPoint.length, device }
  }
  return best?.device ?? null
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

/** The names under slaves/: none for a plain partition, which has no such folder. Null when it cannot be read. */
function slavesOf(deviceDir: string): string[] | null {
  const slavesDir = join(deviceDir, 'slaves')
  if (!existsSync(slavesDir)) return []
  try {
    return readdirSync(slavesDir)
  } catch {
    return null
  }
}

function cryptBackedAt(sys: string, device: string, depth: number): boolean | null {
  if (depth > MAX_DEPTH || !DEVICE_PATTERN.test(device)) return null
  const deviceDir = join(sys, 'dev', 'block', device)
  if (!existsSync(deviceDir)) return null
  if (existsSync(join(deviceDir, 'dm'))) {
    const uuid = readTrimmed(join(deviceDir, 'dm', 'uuid'))
    if (uuid === null) return null
    if (uuid.startsWith(CRYPT_UUID_PREFIX)) return true
  }
  const slaves = slavesOf(deviceDir)
  if (slaves === null) return null
  let unknown = false
  for (const name of slaves) {
    const slaveDevice = SLAVE_NAME_PATTERN.test(name) ? readTrimmed(join(sys, 'class', 'block', name, 'dev')) : null
    const backed = slaveDevice === null ? null : cryptBackedAt(sys, slaveDevice, depth + 1)
    if (backed === true) return true
    if (backed === null) unknown = true
  }
  return unknown ? null : false
}

/** True when a dm-crypt device is the device or below it (LVM on LUKS); null when sysfs cannot say. Depth-limited to 8. */
export function isCryptBacked(sys: string, device: string): boolean | null {
  return cryptBackedAt(sys, device, 0)
}

/** The real path of the data folder, or of its nearest existing ancestor before install creates it. */
function existingRealPath(path: string): string | null {
  let current = path
  for (;;) {
    try {
      return realpathSync(current)
    } catch {
      const parent = dirname(current)
      if (parent === current) return null
      current = parent
    }
  }
}

export function createLuksCheck(roots: LuksRoots): DiskEncryptionCheck {
  return {
    name: 'LUKS',
    async check(env) {
      const path = existingRealPath(env.dataDir)
      const mountinfo = readTrimmed(roots.mountinfo)
      if (path === null || mountinfo === null) return { kind: 'cannot-check' }
      const device = mountDevice(mountinfo, path)
      // Major 0 has no block device behind it: btrfs subvolumes, overlay, tmpfs, ecryptfs.
      if (device === null || device.startsWith('0:')) return { kind: 'cannot-check' }
      const backed = isCryptBacked(roots.sys, device)
      if (backed === null) return { kind: 'cannot-check' }
      return backed ? { kind: 'on' } : { kind: 'off', advice: LUKS_ADVICE }
    },
  }
}

export const luksCheck: DiskEncryptionCheck = createLuksCheck({ mountinfo: '/proc/self/mountinfo', sys: '/sys' })
