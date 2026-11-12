import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly } from '../../../test/platform-guards'
import { SERVICE_PATH_FILE, applyServicePath, readServicePath, servicePathFor, writeServicePath } from './service-path'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-service-path-'))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const found: Record<string, string> = {
  claude: 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  git: 'C:\\Program Files\\Git\\cmd\\git.exe',
  opencode: 'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd',
}
const which = (command: string) => found[command] ?? null
const PROGRAM = 'C:\\Users\\me\\.kinfold\\bin\\kinfold.exe'

test('servicePathFor puts the program dir and each found tool dir first, once each, in PATH order', () => {
  expect(servicePathFor({ bunPath: PROGRAM, pathEnv: 'ignored' }, which)).toBe([
    'C:\\Users\\me\\.kinfold\\bin',
    'C:\\Users\\me\\AppData\\Roaming\\npm',
    // npm's claude.cmd and opencode.cmd run on node, so its folder comes with them.
    'C:\\Program Files\\nodejs',
    'C:\\Program Files\\Git\\cmd',
  ].join(';'))
})

test('servicePathFor drops entries that are not absolute Windows paths', () => {
  const relative = (command: string) => (command === 'claude' ? 'tools\\claude.exe' : null)
  expect(servicePathFor({ bunPath: PROGRAM, pathEnv: '' }, relative)).toBe('C:\\Users\\me\\.kinfold\\bin')
})

test('the recorded PATH round-trips through service-path.json', () => {
  writeServicePath(dataDir, 'C:\\a;C:\\b')
  expect(readServicePath(dataDir)).toBe('C:\\a;C:\\b')
})

posixOnly('file modes')('service-path.json is written owner-only', () => {
  writeServicePath(dataDir, 'C:\\a')
  expect(statSync(join(dataDir, SERVICE_PATH_FILE)).mode & 0o777).toBe(0o600)
})

test('readServicePath is null for a missing file, bad JSON, or a path that is not text', () => {
  expect(readServicePath(dataDir)).toBeNull()
  writeFileSync(join(dataDir, SERVICE_PATH_FILE), '{not json')
  expect(readServicePath(dataDir)).toBeNull()
  writeFileSync(join(dataDir, SERVICE_PATH_FILE), JSON.stringify({ path: 42 }))
  expect(readServicePath(dataDir)).toBeNull()
  writeFileSync(join(dataDir, SERVICE_PATH_FILE), JSON.stringify({ path: '' }))
  expect(readServicePath(dataDir)).toBeNull()
})

test('on Windows the recorded dirs go before the daemon PATH; elsewhere the file is ignored', () => {
  writeServicePath(dataDir, 'C:\\tools;C:\\npm')
  const windows: Record<string, string | undefined> = { PATH: 'C:\\Windows\\System32' }
  applyServicePath(dataDir, windows, 'windows')
  expect(windows.PATH).toBe('C:\\tools;C:\\npm;C:\\Windows\\System32')
  // Windows spells it Path as often as PATH; the existing key is kept.
  const spelled: Record<string, string | undefined> = { Path: 'C:\\Windows' }
  applyServicePath(dataDir, spelled, 'windows')
  expect(spelled).toEqual({ Path: 'C:\\tools;C:\\npm;C:\\Windows' })
  const mac: Record<string, string | undefined> = { PATH: '/usr/bin' }
  applyServicePath(dataDir, mac, 'macos')
  expect(mac.PATH).toBe('/usr/bin')
})
