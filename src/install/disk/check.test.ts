import { afterEach, expect, test } from 'bun:test'
import { dbStatusLines } from '../db-encryption'
import { type FakeWorld, createWorld } from '../test-support'
import { diskCheckOf, diskEncryptionCheckFor, diskEncryptionLine } from './check'
import { stubDiskCheck } from './stub-check'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

test('each platform has its check', () => {
  expect(diskEncryptionCheckFor({ os: 'macos', wsl: false, node: 'darwin' }).name).toBe('FileVault')
  expect(diskEncryptionCheckFor({ os: 'linux', wsl: false, node: 'linux' }).name).toBe('LUKS')
  expect(diskEncryptionCheckFor({ os: 'linux', wsl: true, node: 'linux' }).name).toBe('LUKS')
  expect(diskEncryptionCheckFor({ os: 'windows', wsl: false, node: 'win32' }).name).toBe('BitLocker')
})

test('an injected check wins over the platform one', () => {
  world = createWorld()
  const injected = stubDiskCheck('Test')
  expect(diskCheckOf({ ...world.env, diskCheck: injected })).toBe(injected)
  expect(diskCheckOf(world.env).name).toBe('FileVault')
})

test('a check that cannot check prints no disk line', async () => {
  world = createWorld({ platform: 'linux' })
  const check = stubDiskCheck('Test')
  expect(await check.check(world.env)).toEqual({ kind: 'cannot-check' })
  const lines = await dbStatusLines({ ...world.env, diskCheck: check })
  expect(lines.some((line) => line.includes('disk encryption') || line.includes('unencrypted on disk'))).toBe(false)
  expect(world.commands).toEqual([])
})

test('the line follows the state', () => {
  expect(diskEncryptionLine('Test', { kind: 'on' })).toBe('disk encryption: Test on')
  expect(diskEncryptionLine('Test', { kind: 'off', advice: 'Do the thing' })).toBe(
    'warning: Test is off; the spool, logs and agent transcripts are unencrypted on disk. Do the thing',
  )
  expect(diskEncryptionLine('Test', { kind: 'unknown', detail: 'could not check (probe exit 2)' })).toBe('disk encryption: could not check (probe exit 2)')
  expect(diskEncryptionLine('Test', { kind: 'cannot-check' })).toBeNull()
})
