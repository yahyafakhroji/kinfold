import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSTALL_RECORD_FILE, type InstallRecord, readInstallRecord, setAutoUpdate, setCentralMode, writeInstallRecord } from '../install/setup/record'
import { type CentralMode, centralModeOf, parseCentralMode } from './mode'

const RECORD: InstallRecord = { channel: 'curl', updateCheck: true, autoUpdate: true, autoUpdateIntro: false, agentHomes: {}, firstInstalledAt: 1_792_900_000_000 }
const HUB: CentralMode = { role: 'hub', port: 37_812 }
const DEVICE: CentralMode = {
  role: 'device', hub: 'mini.tail1234.ts.net', port: 37_812, hubName: 'mini', hubPublicKey: `${'A'.repeat(59)}=`, deviceId: 'dev-abc', joinedAt: 1_792_900_000_000,
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-central-mode-'))
})
afterEach(() => {
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

test('with no record, or a record without the field, the mode is local', () => {
  expect(centralModeOf(dir)).toBeNull()
  writeInstallRecord(dir, RECORD)
  expect(centralModeOf(dir)).toBeNull()
  expect(Object.keys(JSON.parse(readFileSync(join(dir, INSTALL_RECORD_FILE), 'utf8')) as object)).not.toContain('central')
})

test('hub and device modes round-trip through install.json', () => {
  writeInstallRecord(dir, RECORD)
  expect(setCentralMode(dir, HUB)).toBe(true)
  expect(centralModeOf(dir)).toEqual(HUB)
  expect(readInstallRecord(dir)).toEqual({ ...RECORD, central: HUB })
  expect(setCentralMode(dir, DEVICE)).toBe(true)
  expect(centralModeOf(dir)).toEqual(DEVICE)
  expect(setCentralMode(dir, null)).toBe(true)
  expect(centralModeOf(dir)).toBeNull()
})

test('setting a mode needs an install record', () => {
  expect(setCentralMode(dir, HUB)).toBe(false)
})

test('a reinstall or another record write keeps the mode the central commands chose', () => {
  writeInstallRecord(dir, RECORD)
  setCentralMode(dir, DEVICE)
  writeInstallRecord(dir, { ...RECORD, channel: 'npx' })
  expect(centralModeOf(dir)).toEqual(DEVICE)
  setAutoUpdate(dir, false, 5)
  expect(centralModeOf(dir)).toEqual(DEVICE)
  // A record handed in with another mode does not change it either: only setCentralMode does.
  writeInstallRecord(dir, { ...RECORD, central: HUB })
  expect(centralModeOf(dir)).toEqual(DEVICE)
})

test('a mode that does not parse reads as local, and the rest of the record still reads', () => {
  writeFileSync(join(dir, INSTALL_RECORD_FILE), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1, central: { role: 'device', hub: 'x; rm -rf', port: 1 } }))
  expect(centralModeOf(dir)).toBeNull()
  expect(readInstallRecord(dir)?.channel).toBe('curl')
})

test('the parser checks every field', () => {
  expect(parseCentralMode(HUB)).toEqual(HUB)
  expect(parseCentralMode({ role: 'hub', port: 80 })).toBeNull()
  expect(parseCentralMode({ role: 'hub', port: 70_000 })).toBeNull()
  expect(parseCentralMode(DEVICE)).toEqual(DEVICE)
  expect(parseCentralMode({ ...DEVICE, hub: '' })).toBeNull()
  expect(parseCentralMode({ ...DEVICE, hub: 'a b' })).toBeNull()
  expect(parseCentralMode({ ...DEVICE, hubPublicKey: 'short' })).toBeNull()
  expect(parseCentralMode({ ...DEVICE, deviceId: '../x' })).toBeNull()
  expect(parseCentralMode({ ...DEVICE, extra: 1 })).toEqual(DEVICE)
  expect(parseCentralMode({ role: 'both' })).toBeNull()
})
