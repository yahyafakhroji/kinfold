import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { currentPlatform } from '../../platform/platform'
import { type FakeWorld, createWorld } from '../test-support'
import { posixOnly } from '../../../test/platform-guards'
import { diskEncryptionLine } from './check'
import { LUKS_ADVICE, createLuksCheck, isCryptBacked, luksCheck, mountDevice } from './luks'

let world: FakeWorld | null = null
let fixtureRoot: string | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = null
})

function mountLine(id: number, device: string, mountPoint: string, fsType: string): string {
  return `${id} 1 ${device} / ${mountPoint} rw,relatime shared:1 - ${fsType} /dev/x rw`
}

/** A fake /proc/self/mountinfo and /sys under a temp root; `files` are paths relative to the sys root. */
function fixture(mounts: string[], files: Record<string, string>): { mountinfo: string; sys: string } {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'luks-'))
  const mountinfo = join(fixtureRoot, 'mountinfo')
  writeFileSync(mountinfo, `${mounts.join('\n')}\n`)
  const sys = join(fixtureRoot, 'sys')
  mkdirSync(sys)
  for (const [path, content] of Object.entries(files)) {
    const full = join(sys, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return { mountinfo, sys }
}

async function checkWith(roots: { mountinfo: string; sys: string }) {
  world = createWorld({ platform: 'linux' })
  const state = await createLuksCheck(roots).check(world.env)
  expect(world.commands).toEqual([])
  return state
}

const PLAIN_PARTITION = { 'dev/block/8:2/partition': '2\n' }
const CRYPT_ROOT = { 'dev/block/253:0/dm/uuid': 'CRYPT-LUKS2-abc-luks\n' }

posixOnly('POSIX paths')('a plain partition is off with the advice', async () => {
  const state = await checkWith(fixture([mountLine(20, '8:2', '/', 'ext4')], PLAIN_PARTITION))
  expect(state).toEqual({ kind: 'off', advice: LUKS_ADVICE })
  expect(diskEncryptionLine('LUKS', state)).toBe(
    'warning: LUKS is off; the spool, logs and agent transcripts are unencrypted on disk. LUKS is set up when a disk is formatted; keep the data folder on an encrypted volume',
  )
})

posixOnly('POSIX paths')('a dm-crypt mount is on', async () => {
  expect(await checkWith(fixture([mountLine(20, '253:0', '/', 'ext4')], CRYPT_ROOT))).toEqual({ kind: 'on' })
})

posixOnly('POSIX paths')('LVM on LUKS is on', async () => {
  const roots = fixture([mountLine(20, '253:1', '/', 'ext4')], {
    'dev/block/253:1/dm/uuid': 'LVM-x\n',
    'dev/block/253:1/slaves/dm-0': '',
    'class/block/dm-0/dev': '253:0\n',
    ...CRYPT_ROOT,
  })
  expect(await checkWith(roots)).toEqual({ kind: 'on' })
})

posixOnly('POSIX paths')('a device-mapper device that is not crypt is off', async () => {
  const roots = fixture([mountLine(20, '253:1', '/', 'ext4')], {
    'dev/block/253:1/dm/uuid': 'LVM-x\n',
    'dev/block/253:1/slaves/sda2': '',
    'class/block/sda2/dev': '8:2\n',
    ...PLAIN_PARTITION,
  })
  expect(await checkWith(roots)).toEqual({ kind: 'off', advice: LUKS_ADVICE })
})

posixOnly('POSIX paths')('a mount without a block device prints nothing', async () => {
  const state = await checkWith(fixture([mountLine(20, '0:35', '/', 'overlay')], {}))
  expect(state).toEqual({ kind: 'cannot-check' })
  expect(diskEncryptionLine('LUKS', state)).toBeNull()
})

test('the longest mount point wins and escapes are decoded', () => {
  const mountinfo = [mountLine(20, '8:1', '/', 'ext4'), mountLine(21, '253:0', '/home/a\\040b', 'ext4')].join('\n')
  expect(mountDevice(mountinfo, '/home/a b/.kinfold')).toBe('253:0')
  expect(mountDevice(mountinfo, '/home/a b')).toBe('253:0')
  expect(mountDevice(mountinfo, '/home/a bc')).toBe('8:1')
  expect(mountDevice(mountinfo, '/var')).toBe('8:1')
  expect(mountDevice('', '/var')).toBeNull()
})

test('a later mount on the same point hides the earlier one', () => {
  const mountinfo = [mountLine(20, '8:1', '/', 'ext4'), mountLine(21, '8:3', '/data', 'ext4'), mountLine(22, '0:40', '/data', 'tmpfs')].join('\n')
  expect(mountDevice(mountinfo, '/data/x')).toBe('0:40')
})

posixOnly('POSIX paths')('a bind mount reports the device it came from', async () => {
  // A bind mount's root field names the source folder; its major:minor is the source filesystem's.
  const bind = '30 20 253:0 /srv/data / rw,relatime shared:1 - ext4 /dev/mapper/root rw'
  expect(await checkWith(fixture([bind], CRYPT_ROOT))).toEqual({ kind: 'on' })
})

posixOnly('POSIX paths')('missing sysfs files mean cannot-check, and no command runs', async () => {
  const roots = fixture([mountLine(20, '8:2', '/', 'ext4')], {})
  rmSync(roots.sys, { recursive: true })
  expect(await checkWith(roots)).toEqual({ kind: 'cannot-check' })
})

posixOnly('POSIX paths')('an unreadable mountinfo means cannot-check', async () => {
  const roots = fixture([], PLAIN_PARTITION)
  rmSync(roots.mountinfo)
  expect(await checkWith(roots)).toEqual({ kind: 'cannot-check' })
})

test('a slave whose dev file is missing means sysfs cannot say', () => {
  const roots = fixture([], { 'dev/block/253:1/dm/uuid': 'LVM-x\n', 'dev/block/253:1/slaves/dm-0': '' })
  expect(isCryptBacked(roots.sys, '253:1')).toBeNull()
})

test('a device chain deeper than the limit means sysfs cannot say', () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 12; i++) {
    files[`dev/block/253:${i}/dm/uuid`] = 'LVM-x\n'
    files[`dev/block/253:${i}/slaves/dm-${i + 1}`] = ''
    files[`class/block/dm-${i + 1}/dev`] = `253:${i + 1}\n`
  }
  files['dev/block/253:12/dm/uuid'] = 'CRYPT-LUKS2-deep\n'
  expect(isCryptBacked(fixture([], files).sys, '253:0')).toBeNull()
})

test('a device name that is not major:minor is refused', () => {
  expect(isCryptBacked(fixture([], PLAIN_PARTITION).sys, '../8:2')).toBeNull()
})

test.skipIf(currentPlatform().os !== 'linux')('the check reads this Linux runner without a command', async () => {
  world = createWorld({ platform: 'linux' })
  const state = await luksCheck.check(world.env)
  expect(['on', 'off', 'cannot-check']).toContain(state.kind)
  expect(world.commands).toEqual([])
})
