import { afterEach, beforeEach, expect, test } from 'bun:test'
import { runKinfold } from '../cli/kinfold'
import { USAGE } from '../install/args'
import { type InstallRecord, setCentralMode, writeInstallRecord } from '../install/setup/record'
import { type FakeWorld, createWorld } from '../install/test-support'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1 }
let world: FakeWorld
beforeEach(() => {
  world = createWorld()
  writeInstallRecord(world.dataDir, RECORD)
})
afterEach(async () => {
  await world.cleanup()
})

test('kinfold central runs the central commands and lists them in the usage', async () => {
  expect(await runKinfold(['central', 'devices'], world.env)).toBe(1)
  expect(world.out.join('\n')).toContain('This machine is not the hub; run kinfold central serve first.')
  expect(await runKinfold(['central', 'bogus'], world.env)).toBe(2)
  expect(USAGE).toContain('central    serve [--port <n>]')
})

test('on a central device the commands that change stored memory are refused with "run this on the hub"', async () => {
  setCentralMode(world.dataDir, { role: 'device', hub: 'mini', port: 37_812, hubName: 'mini', hubPublicKey: `${'A'.repeat(59)}=`, deviceId: 'dev-a', joinedAt: 1 })
  for (const argv of [['backup', '/tmp/x.kinfold'], ['restore', '/tmp/x.kinfold'], ['encrypt'], ['decrypt'], ['rekey'], ['key', 'recover']]) {
    world.out.length = 0
    expect(await runKinfold(argv, world.env)).toBe(1)
    expect(world.out.join('\n')).toContain('run this on the hub (mini): this device uses central memory')
  }
})
