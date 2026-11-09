import { expect, test } from 'bun:test'
import { compareVersions, parseVersion } from './version-order'

test('a pre-release sorts before its release', () => {
  expect(compareVersions('0.1.0-rc.1', '0.1.0')).toBeLessThan(0)
  expect(compareVersions('0.1.0', '0.1.0-rc.1')).toBeGreaterThan(0)
})

test('versions compare as numbers, not text', () => {
  expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  expect(compareVersions('0.1.0-rc.2', '0.1.0-rc.10')).toBeLessThan(0)
  expect(compareVersions('0.1.0-alpha', '0.1.0-alpha.1')).toBeLessThan(0)
})

test('parseVersion rejects what is not semver', () => {
  expect(parseVersion('v0.2.0')).toBeNull()
  expect(parseVersion('0.2')).toBeNull()
  expect(parseVersion('01.2.3')).toBeNull()
  expect(parseVersion('0.2.0-rc.1')).toEqual({ major: 0, minor: 2, patch: 0, pre: 'rc.1' })
})
