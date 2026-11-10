// The Linux (WSL included) disk check. It reads mountinfo, /dev symlinks and
// sysfs only, so it runs no command and needs no root. The data folder's own
// mount is what counts, since a home or data volume can be encrypted when / is not.

import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { DiskEncryptionCheck } from './check'

export interface LuksRoots { mountinfo: string; sys: string; dev: string }

export const LUKS_ADVICE = 'LUKS is set up when a disk is formatted; keep the data folder on an encrypted volume'

// LVM on LUKS is two levels deep; anything past this is a loop or a stack sysfs
// cannot describe plainly.
const MAX_DEPTH = 8

const DEVICE_PATTERN = /^\d+:\d+$/
const BLOCK_NAME_PATTERN = /^[^/\\]+$/
const CRYPT_UUID_PREFIX = 'CRYPT-'
const DEV_PREFIX = '/dev/'

interface MountEntry { device: string; fsType: string; source: string }

// mountinfo escapes space, tab, newline and backslash as \ooo octal.
function decodeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
}

function contains(mountPoint: string, path: string): boolean {
  if (mountPoint === '/') return path.startsWith('/')
  return path === mountPoint || path.startsWith(`${mountPoint}/`)
}

// Fields 0-4 are fixed; a variable run of optional fields then ends at "-",
// after which come the fs type and the mount source.
function parseMountLine(line: string): (MountEntry & { mountPoint: string }) | null {
  const fields = line.split(' ')
  const [, , device, , rawMountPoint] = fields
  if (device === undefined || rawMountPoint === undefined || !DEVICE_PATTERN.test(device)) return null
  const separator = fields.indexOf('-', 5)
  const fsType = separator === -1 ? '' : (fields[separator + 1] ?? '')
  const source = separator === -1 ? '' : decodeMountField(fields[separator + 2] ?? '')
  return { device, fsType, source, mountPoint: decodeMountField(rawMountPoint) }
}

function mountEntry(mountinfo: string, path: string): MountEntry | null {
  let best: (MountEntry & { mountPoint: string }) | null = null
  for (const line of mountinfo.split('\n')) {
    const entry = parseMountLine(line)
    if (entry === null || !contains(entry.mountPoint, path)) continue
    // >= so a later mount on the same point, which hides the earlier one, wins.
    if (best === null || entry.mountPoint.length >= best.mountPoint.length) best = entry
  }
  return best
}

/** "major:minor" of the mount with the longest mount point containing `path`; null when none. Decodes \040-style escapes. */
export function mountDevice(mountinfo: string, path: string): string | null {
  return mountEntry(mountinfo, path)?.device ?? null
}

function readTrimmed(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function listDir(path: string): string[] | null {
  try {
    return readdirSync(path)
  } catch {
    return null
  }
}

function blockDeviceOf(sys: string, name: string): string | null {
  return BLOCK_NAME_PATTERN.test(name) ? readTrimmed(join(sys, 'class', 'block', name, 'dev')) : null
}

// A device is crypt-backed when it is dm-crypt itself, or when every device
// below it is. One plain leaf, such as an LVM volume spanning an encrypted and
// a plain disk, leaves data unencrypted, so it makes the whole volume off.
function cryptBackedAt(sys: string, device: string, depth: number): boolean | null {
  if (depth > MAX_DEPTH || !DEVICE_PATTERN.test(device)) return null
  const deviceDir = join(sys, 'dev', 'block', device)
  // Listing the folder rather than probing names tells a missing entry from an unreadable one.
  const entries = listDir(deviceDir)
  if (entries === null) return null
  if (entries.includes('dm')) {
    const uuid = readTrimmed(join(deviceDir, 'dm', 'uuid'))
    if (uuid === null) return null
    if (uuid.startsWith(CRYPT_UUID_PREFIX)) return true
  }
  // A partition has no slaves/ folder; it is a leaf with no crypt layer.
  const slaves = entries.includes('slaves') ? listDir(join(deviceDir, 'slaves')) : []
  if (slaves === null) return null
  if (slaves.length === 0) return false
  let unknown = false
  for (const name of slaves) {
    const slaveDevice = blockDeviceOf(sys, name)
    const backed = slaveDevice === null ? null : cryptBackedAt(sys, slaveDevice, depth + 1)
    if (backed === false) return false
    if (backed === null) unknown = true
  }
  return unknown ? null : true
}

/** True when every path below the device reaches a dm-crypt layer (LVM on LUKS); null when sysfs cannot say. Depth-limited to 8. */
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

// btrfs reports an anonymous major-0 device per subvolume, so the real block
// device comes from the mount source: /dev/mapper/x resolves to /dev/dm-0,
// whose sysfs entry names its major:minor. A multi-device btrfs shows one member.
function btrfsDevice(roots: LuksRoots, source: string): string | null {
  if (!source.startsWith(DEV_PREFIX)) return null
  try {
    return blockDeviceOf(roots.sys, basename(realpathSync(join(roots.dev, source.slice(DEV_PREFIX.length)))))
  } catch {
    return null
  }
}

function blockDeviceFor(roots: LuksRoots, entry: MountEntry): string | null {
  if (entry.fsType === 'btrfs') return btrfsDevice(roots, entry.source)
  // Any other major 0 has no block device to read: overlay, tmpfs, ecryptfs, zfs.
  return entry.device.startsWith('0:') ? null : entry.device
}

export function createLuksCheck(roots: LuksRoots): DiskEncryptionCheck {
  return {
    name: 'LUKS',
    async check(env) {
      const path = existingRealPath(env.dataDir)
      const mountinfo = readTrimmed(roots.mountinfo)
      if (path === null || mountinfo === null) return { kind: 'cannot-check' }
      const entry = mountEntry(mountinfo, path)
      const device = entry === null ? null : blockDeviceFor(roots, entry)
      if (device === null) return { kind: 'cannot-check' }
      const backed = isCryptBacked(roots.sys, device)
      if (backed === null) return { kind: 'cannot-check' }
      return backed ? { kind: 'on' } : { kind: 'off', advice: LUKS_ADVICE }
    },
  }
}

export const luksCheck: DiskEncryptionCheck = createLuksCheck({ mountinfo: '/proc/self/mountinfo', sys: '/sys', dev: '/dev' })
