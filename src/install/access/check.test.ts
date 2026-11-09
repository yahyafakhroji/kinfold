import { afterEach, expect, mock, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXIT_OK, install } from '../install'
import { status } from '../status'
import { type FakeWorld, YES, createWorld } from '../test-support'
import type { DataDirAccess } from './check'
import { dataDirAccessFor } from './check'
import { posixOnly } from '../../../test/platform-guards'

// The real factories, kept so the spies below can be undone: mock.module lasts for
// the whole process, and other test files use the real modules.
const realPosix = { ...(await import('./posix-modes')) }
const realWindows = { ...(await import('./windows-acl')) }

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function restoreRealModules(): void {
  mock.module('./posix-modes', () => realPosix)
  mock.module('./windows-acl', () => realWindows)
}

function looseDataDir(w: FakeWorld): void {
  mkdirSync(w.dataDir, { recursive: true })
  chmodSync(w.dataDir, 0o700)
  writeFileSync(join(w.dataDir, 'memory.db'), '')
  chmodSync(join(w.dataDir, 'memory.db'), 0o644)
}

const quietAccess: DataDirAccess = {
  plannedFixes: () => ({ changes: [], symlinks: [] }),
  statusLines: async () => ['data dir x: test line'],
}

test('an access check with no fixes plans no chmod', async () => {
  world = createWorld({ opencodeVersion: undefined, keychainRefs: [] })
  looseDataDir(world)
  const env = { ...world.env, dataDirAccess: quietAccess }
  expect(await install(env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  expect(world.out.some((line) => line.includes('chmod'))).toBe(false)
  world.out.length = 0
  await status(env)
  expect(world.out).toContain('data dir x: test line')
  expect(world.out.some((line) => line.includes('need fixing'))).toBe(false)
})

posixOnly('file modes')('the mode check still plans the chmod on a linux world', async () => {
  world = createWorld({ platform: 'linux', withLibrary: false, opencodeVersion: undefined, keychainRefs: [] })
  looseDataDir(world)
  await status(world.env)
  const out = world.out.join('\n')
  expect(out).toContain('1 of 2 need fixing')
  expect(out).toContain('  memory.db 0644 -> 0600')
  expect(dataDirAccessFor(world.env).plannedFixes(world.dataDir).changes).toEqual([{ path: 'memory.db', kind: 'file', from: 0o644, to: 0o600 }])
})

test('each platform gets its access check', () => {
  // Both are factories, so selection is checked by the value each spy returned.
  const posix: DataDirAccess = { ...quietAccess }
  const windows: DataDirAccess = { ...quietAccess }
  const posixSpy = mock(() => posix)
  const windowsSpy = mock(() => windows)
  mock.module('./posix-modes', () => ({ ...realPosix, posixModeAccess: posixSpy }))
  mock.module('./windows-acl', () => ({ ...realWindows, windowsAclAccess: windowsSpy }))
  // Undone inside the test, so no other test in this file ever sees the spies.
  try {
    world = createWorld()
    expect(dataDirAccessFor({ ...world.env, platform: 'darwin' })).toBe(posix)
    expect(dataDirAccessFor({ ...world.env, platform: 'linux' })).toBe(posix)
    expect(dataDirAccessFor({ ...world.env, platform: 'linux', wsl: true })).toBe(posix)
    expect(dataDirAccessFor({ ...world.env, platform: 'win32' })).toBe(windows)
    expect(posixSpy).toHaveBeenCalledTimes(3)
    expect(windowsSpy).toHaveBeenCalledTimes(1)
    // The injected one wins over any platform's.
    expect(dataDirAccessFor({ ...world.env, platform: 'win32', dataDirAccess: quietAccess })).toBe(quietAccess)
    expect(windowsSpy).toHaveBeenCalledTimes(1)
  } finally {
    restoreRealModules()
  }
})
