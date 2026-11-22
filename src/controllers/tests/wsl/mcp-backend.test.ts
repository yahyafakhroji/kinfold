import { expect, test } from 'bun:test'
import type { PlatformInfo } from '../platform/platform'
import { isOnWindowsDrive, mcpToolCallerFor } from './mcp-backend'

const WSL: PlatformInfo = { os: 'linux', wsl: true, node: 'linux' }
const LINUX: PlatformInfo = { os: 'linux', wsl: false, node: 'linux' }
const WINDOWS: PlatformInfo = { os: 'windows', wsl: false, node: 'win32' }
const CWD = '/home/me/p'

test('only WSL with a Windows data folder reads through the daemon', () => {
  expect(mcpToolCallerFor({ dataDir: '/mnt/c/Users/me/.kinfold', cwd: CWD, platform: WSL })).toBeFunction()
  expect(mcpToolCallerFor({ dataDir: '/home/me/.kinfold', cwd: CWD, platform: WSL })).toBeNull()
  expect(mcpToolCallerFor({ dataDir: '/mnt/c/Users/me/.kinfold', cwd: CWD, platform: LINUX })).toBeNull()
  expect(mcpToolCallerFor({ dataDir: 'C:\\Users\\me\\.kinfold', cwd: 'C:\\p', platform: WINDOWS })).toBeNull()
})

test('isOnWindowsDrive takes a lowercase drive mount only', () => {
  expect(isOnWindowsDrive('/mnt/d/data')).toBe(true)
  expect(isOnWindowsDrive('/mnt/c')).toBe(false)
  expect(isOnWindowsDrive('/mnt/wsl/x')).toBe(false)
  expect(isOnWindowsDrive('/home/mnt/c/x')).toBe(false)
})
