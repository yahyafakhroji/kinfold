import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { currentPlatform } from '../../platform/platform'
import { type FakeWorld, createWorld } from '../test-support'
import { diskEncryptionLine } from './check'
import { LUKS_ADVICE, type LuksRoots, createLuksCheck, isCryptBacked, luksCheck, mountDevice } from './luks'

// sysfs names its devices "major:minor", and Windows cannot create a folder
// name holding ':', so the sysfs fixtures cannot be built there.
const sysfsFixtureTest = test.skipIf(currentPlatform().os === 'windows')

let world: FakeWorld | null = null
let fixtureRoot: string | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = null
})

function mountLine(id: number, device: string, mountPoint: string, fsType: string, source = '/dev/x', optional = 'shared:1'): string {
  const optionalFields = optional === '' ? '' : `${optional} `
  return `${id} 1 ${device} / ${mountPoint} rw,relatime ${optionalFields}- ${fsType} ${source} rw`
}

interface FixtureFiles {
  /** Paths relative to the sys root, and their contents. */
  sys?: Record<string, string>
  /** Paths relative to the dev root: a string is a symlink target, null a plain device file. */
  dev?: Record<string, string | null>
}

/** A fake /proc/self/mountinfo, /sys and /dev under a temp root. */
function fixture(mounts: string[], files: FixtureFiles = {}): LuksRoots {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'luks-'))
  const mountinfo = join(fixtureRoot, 'mountinfo')
  writeFileSync(mountinfo, `${mounts.join('\n')}\n`)
  const sys = join(fixtureRoot, 'sys')
  const dev = join(fixtureRoot, 'dev')
  mkdirSync(sys)
  mkdirSync(dev)
  for (const [path, content] of Object.entries(files.sys ?? {})) {
    const full = join(sys, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  for (const [path, target] of Object.entries(files.dev ?? {})) {
    const full = join(dev, path)
    mkdirSync(dirname(full), { recursive: true })
    if (target === null) writeFileSync(full, '')
    else symlinkSync(target, full)
  }
  return { mountinfo, sys, dev }
}

async function checkWith(roots: LuksRoots) {
  world = createWorld({ platform: 'linux' })
  const state = await createLuksCheck(roots).check(world.env)
  expect(world.commands).toEqual([])
  return state
}

const PLAIN_PARTITION = { 'dev/block/8:2/partition': '2\n' }
const CRYPT_ROOT = { 'dev/block/253:0/dm/uuid': 'CRYPT-LUKS2-abc-luks\n' }

sysfsFixtureTest('a plain partition is off with the advice', async () => {
  const state = await checkWith(fixture([mountLine(20, '8:2', '/', 'ext4')], { sys: PLAIN_PARTITION }))
  expect(state).toEqual({ kind: 'off', advice: LUKS_ADVICE })
  expect(diskEncryptionLine('LUKS', state)).toBe(
    'warning: LUKS is off; the spool, logs and agent transcripts are unencrypted on disk. LUKS is set up when a disk is formatted; keep the data folder on an encrypted volume',
  )
})

sysfsFixtureTest('a dm-crypt mount is on', async () => {
  expect(await checkWith(fixture([mountLine(20, '253:0', '/', 'ext4')], { sys: CRYPT_ROOT }))).toEqual({ kind: 'on' })
})

sysfsFixtureTest('LVM on LUKS is on', async () => {
  const roots = fixture([mountLine(20, '253:1', '/', 'ext4')], {
    sys: { 'dev/block/253:1/dm/uuid': 'LVM-x\n', 'dev/block/253:1/slaves/dm-0': '', 'class/block/dm-0/dev': '253:0\n', ...CRYPT_ROOT },
  })
  expect(await checkWith(roots)).toEqual({ kind: 'on' })
})

sysfsFixtureTest('a device-mapper device that is not crypt is off', async () => {
  const roots = fixture([mountLine(20, '253:1', '/', 'ext4')], {
    sys: { 'dev/block/253:1/dm/uuid': 'LVM-x\n', 'dev/block/253:1/slaves/sda2': '', 'class/block/sda2/dev': '8:2\n', ...PLAIN_PARTITION },
  })
  expect(await checkWith(roots)).toEqual({ kind: 'off', advice: LUKS_ADVICE })
})

sysfsFixtureTest('an LVM volume spanning an encrypted and a plain disk is off', async () => {
  const roots = fixture([mountLine(20, '253:1', '/', 'ext4')], {
    sys: {
      'dev/block/253:1/dm/uuid': 'LVM-x\n',
      'dev/block/253:1/slaves/dm-0': '',
      'dev/block/253:1/slaves/sda2': '',
      'class/block/dm-0/dev': '253:0\n',
      'class/block/sda2/dev': '8:2\n',
      ...CRYPT_ROOT,
      ...PLAIN_PARTITION,
    },
  })
  expect(await checkWith(roots)).toEqual({ kind: 'off', advice: LUKS_ADVICE })
})

sysfsFixtureTest('a mount without a block device prints nothing', async () => {
  const state = await checkWith(fixture([mountLine(20, '0:35', '/', 'overlay', 'overlay')]))
  expect(state).toEqual({ kind: 'cannot-check' })
  expect(diskEncryptionLine('LUKS', state)).toBeNull()
})

sysfsFixtureTest('btrfs on LUKS is on', async () => {
  const roots = fixture([mountLine(20, '0:42', '/', 'btrfs', '/dev/mapper/luks-abc')], {
    sys: { 'class/block/dm-0/dev': '253:0\n', ...CRYPT_ROOT },
    dev: { 'dm-0': null, 'mapper/luks-abc': '../dm-0' },
  })
  expect(await checkWith(roots)).toEqual({ kind: 'on' })
})

sysfsFixtureTest('btrfs on a plain partition is off', async () => {
  const roots = fixture([mountLine(20, '0:42', '/', 'btrfs', '/dev/sda2')], {
    sys: { 'class/block/sda2/dev': '8:2\n', ...PLAIN_PARTITION },
    dev: { sda2: null },
  })
  expect(await checkWith(roots)).toEqual({ kind: 'off', advice: LUKS_ADVICE })
})

sysfsFixtureTest('btrfs whose source cannot be resolved prints nothing', async () => {
  for (const source of ['/dev/mapper/gone', 'none']) {
    const state = await checkWith(fixture([mountLine(20, '0:42', '/', 'btrfs', source)], { sys: CRYPT_ROOT }))
    expect(state).toEqual({ kind: 'cannot-check' })
    expect(diskEncryptionLine('LUKS', state)).toBeNull()
    await world?.cleanup()
    world = null
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = null
  }
})

test('the longest mount point wins and escapes are decoded', () => {
  const mountinfo = [mountLine(20, '8:1', '/', 'ext4'), mountLine(21, '253:0', '/home/a\\040b', 'ext4')].join('\n')
  expect(mountDevice(mountinfo, '/home/a b/.kinfold')).toBe('253:0')
  expect(mountDevice(mountinfo, '/home/a b')).toBe('253:0')
  expect(mountDevice(mountinfo, '/home/a bc')).toBe('8:1')
  expect(mountDevice(mountinfo, '/var')).toBe('8:1')
  expect(mountDevice('', '/var')).toBeNull()
})

test('the mount point is found with no optional fields or with several', () => {
  const mountinfo = [mountLine(20, '8:1', '/', 'ext4', '/dev/x', ''), mountLine(21, '8:3', '/data', 'ext4', '/dev/y', 'shared:1 master:2')].join('\n')
  expect(mountDevice(mountinfo, '/data/x')).toBe('8:3')
  expect(mountDevice(mountinfo, '/var')).toBe('8:1')
})

test('a later mount on the same point hides the earlier one', () => {
  const mountinfo = [mountLine(20, '8:1', '/', 'ext4'), mountLine(21, '8:3', '/data', 'ext4'), mountLine(22, '0:40', '/data', 'tmpfs')].join('\n')
  expect(mountDevice(mountinfo, '/data/x')).toBe('0:40')
})

sysfsFixtureTest('a bind mount reports the device it came from', async () => {
  // A bind mount's root field names the source folder; its major:minor is the source filesystem's.
  const bind = '30 20 253:0 /srv/data / rw,relatime shared:1 - ext4 /dev/mapper/root rw'
  expect(await checkWith(fixture([bind], { sys: CRYPT_ROOT }))).toEqual({ kind: 'on' })
})

sysfsFixtureTest('missing sysfs files mean cannot-check, and no command runs', async () => {
  const roots = fixture([mountLine(20, '8:2', '/', 'ext4')])
  rmSync(roots.sys, { recursive: true })
  expect(await checkWith(roots)).toEqual({ kind: 'cannot-check' })
})

sysfsFixtureTest('an unreadable mountinfo means cannot-check', async () => {
  const roots = fixture([], { sys: PLAIN_PARTITION })
  rmSync(roots.mountinfo)
  expect(await checkWith(roots)).toEqual({ kind: 'cannot-check' })
})

sysfsFixtureTest('an unreadable slaves folder means sysfs cannot say', () => {
  // A file where the folder should be fails the listing the way EACCES would, and works as root too.
  const roots = fixture([], { sys: { 'dev/block/253:1/dm/uuid': 'LVM-x\n', 'dev/block/253:1/slaves': '' } })
  expect(isCryptBacked(roots.sys, '253:1')).toBeNull()
})

sysfsFixtureTest('a slave whose dev file is missing means sysfs cannot say', () => {
  const roots = fixture([], { sys: { 'dev/block/253:1/dm/uuid': 'LVM-x\n', 'dev/block/253:1/slaves/dm-0': '' } })
  expect(isCryptBacked(roots.sys, '253:1')).toBeNull()
})

function chain(levels: number): Record<string, string> {
  const files: Record<string, string> = {}
  for (let i = 0; i < levels; i++) {
    files[`dev/block/253:${i}/dm/uuid`] = 'LVM-x\n'
    files[`dev/block/253:${i}/slaves/dm-${i + 1}`] = ''
    files[`class/block/dm-${i + 1}/dev`] = `253:${i + 1}\n`
  }
  files[`dev/block/253:${levels}/dm/uuid`] = 'CRYPT-LUKS2-deep\n'
  return files
}

sysfsFixtureTest('a crypt layer at the depth limit still counts', () => {
  expect(isCryptBacked(fixture([], { sys: chain(8) }).sys, '253:0')).toBe(true)
})

sysfsFixtureTest('a device chain deeper than the limit means sysfs cannot say', () => {
  expect(isCryptBacked(fixture([], { sys: chain(9) }).sys, '253:0')).toBeNull()
})

sysfsFixtureTest('a device name that is not major:minor is refused', () => {
  expect(isCryptBacked(fixture([], { sys: PLAIN_PARTITION }).sys, '../8:2')).toBeNull()
})

test.skipIf(currentPlatform().os !== 'linux')('the check reads this Linux runner without a command', async () => {
  world = createWorld({ platform: 'linux' })
  const state = await luksCheck.check(world.env)
  expect(['on', 'off', 'cannot-check']).toContain(state.kind)
  expect(world.commands).toEqual([])
})
