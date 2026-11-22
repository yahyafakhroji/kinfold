import { expect, test } from 'bun:test'
import { platformOf } from '../install/env'
import { detectPlatform, osOf, type PlatformProbe } from './platform'

function probe(platform: NodeJS.Platform, overrides: Partial<PlatformProbe> = {}): PlatformProbe {
  return { platform, osRelease: () => null, env: {}, ...overrides }
}

test('macOS, Linux and Windows map to their names', () => {
  expect(detectPlatform(probe('darwin'))).toEqual({ os: 'macos', wsl: false, node: 'darwin' })
  expect(detectPlatform(probe('linux'))).toEqual({ os: 'linux', wsl: false, node: 'linux' })
  expect(detectPlatform(probe('win32'))).toEqual({ os: 'windows', wsl: false, node: 'win32' })
})

test('WSL is found from the kernel release or the distro variable', () => {
  expect(detectPlatform(probe('linux', { osRelease: () => '5.15.153.1-microsoft-standard-WSL2' })).wsl).toBe(true)
  expect(detectPlatform(probe('linux', { osRelease: () => '6.8.0-45-generic', env: { WSL_DISTRO_NAME: 'Ubuntu' } })).wsl).toBe(true)
  expect(detectPlatform(probe('linux', { osRelease: () => '6.8.0-45-generic' })).wsl).toBe(false)
  expect(detectPlatform(probe('win32', { env: { WSL_DISTRO_NAME: 'Ubuntu' } })).wsl).toBe(false)
  const throwing = () => {
    throw new Error('unreadable')
  }
  expect(detectPlatform(probe('linux', { osRelease: throwing })).wsl).toBe(false)
})

test('another platform is refused by name', () => {
  expect(() => detectPlatform(probe('freebsd'))).toThrow('kinfold runs on macOS, Linux and Windows, not freebsd')
  expect(osOf('aix')).toBeNull()
})

test('platformOf reports WSL only on Linux', () => {
  expect(platformOf({ platform: 'linux', wsl: true }).wsl).toBe(true)
  expect(platformOf({ platform: 'darwin', wsl: true }).wsl).toBe(false)
})
