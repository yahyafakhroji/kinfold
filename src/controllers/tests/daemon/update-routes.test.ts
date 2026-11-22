// The Install button's refusals that need the store busy, which the daemon
// rig cannot set up without running a real backup.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readInstallRun } from '../../update/install-run'
import { updateRouteHandlers } from '../../daemon/update-routes'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-update-routes-'))
  writeFileSync(join(dir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1 }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the Install button refuses while a backup or restore runs, and starts nothing', () => {
  const spawned: string[][] = []
  const handlers = updateRouteHandlers({
    dataDir: dir, version: '0.5.0', platform: 'darwin', envVars: () => ({}), now: () => 1, log: () => {},
    storeBusy: () => 'a backup or restore is running; try again when it finishes',
    program: { path: '/data/bin/kinfold', os: 'macos' },
    spawn: (argv) => (spawned.push(argv), 1),
  })
  expect(handlers.install('0.6.0')).toEqual({ status: 409, body: { error: 'a backup or restore is running; try again when it finishes' } })
  expect(spawned).toEqual([])
  expect(readInstallRun(dir)).toBeNull()
})
