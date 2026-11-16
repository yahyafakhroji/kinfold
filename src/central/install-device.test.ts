// Re-running install (and so `kinfold update`, which runs it) on a central
// device: what belongs to the hub is not sent to the daemon, which would
// refuse it, and the device's own display switches still are.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { embeddingActions, settingsActions } from '../install/install'
import { type InstallRecord, setCentralMode, writeInstallRecord } from '../install/setup/record'
import { type FakeWorld, createWorld } from '../install/test-support'
import { isHubOnly } from './device-routes'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1 }
let world: FakeWorld
beforeEach(() => {
  world = createWorld()
  writeInstallRecord(world.dataDir, RECORD)
  setCentralMode(world.dataDir, { role: 'device', hub: '100.64.0.2', port: 37_812, hubName: 'mini', hubPublicKey: `${'A'.repeat(59)}=`, deviceId: 'dev-a', joinedAt: 1 })
})
afterEach(async () => {
  await world.cleanup()
})

test('a device plans no observer or embedding change, and says the hub keeps them', async () => {
  const choice = { origin: 'flag' as const, input: { host: 'claude-code', provider: 'claude-cli', model: 'haiku' } }
  expect(await settingsActions(world.env, [choice] as never, { failedProviders: [] })).toEqual([])
  expect(embeddingActions(world.env, { embeddings: { provider: 'local' } } as never, false)).toEqual([])
  expect(world.out.join('\n')).toContain('observer settings: kept on the hub (mini); this device uses central memory')
  expect(world.out.join('\n')).toContain('embedding choice: kept on the hub (mini); this device uses central memory')
})

test('the display switches stay on the device', () => {
  expect(isHubOnly('PUT', '/data/display')).toBe(false)
})
