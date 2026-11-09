import { expect, test } from 'bun:test'
import { skipsOn } from './platform-guards'

test('posix guards skip only on Windows and macOS guards skip off macOS', () => {
  expect(skipsOn('posix', 'windows')).toBe(true)
  expect(skipsOn('posix', 'linux')).toBe(false)
  expect(skipsOn('posix', 'macos')).toBe(false)
  expect(skipsOn('macos', 'linux')).toBe(true)
  expect(skipsOn('macos', 'windows')).toBe(true)
  expect(skipsOn('macos', 'macos')).toBe(false)
})
