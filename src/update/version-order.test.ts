import { expect, test } from 'bun:test'
import { compareVersions, isPatchUpdate, parseVersion } from './version-order'

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

test('a higher patch of the same major.minor is a patch update', () => {
  expect(isPatchUpdate('0.2.0', '0.2.1')).toBe(true)
  expect(isPatchUpdate('0.2.1', '0.2.10')).toBe(true)
})

test('a minor, a major, a prerelease, the same or an older version is not a patch update', () => {
  for (const latest of ['0.3.0', '1.0.0', '0.2.1-rc.1', '0.2.0', '0.1.9']) expect(isPatchUpdate('0.2.0', latest)).toBe(false)
})

test('a running prerelease never takes a patch update', () => {
  expect(isPatchUpdate('0.2.0-rc.1', '0.2.0')).toBe(false)
  expect(isPatchUpdate('0.2.0-rc.1', '0.2.1')).toBe(false)
})

test('a version that does not parse is never a patch update', () => {
  expect(isPatchUpdate('0.0.0-dev', '0.0.1')).toBe(false)
  expect(isPatchUpdate('0.2.0', 'v0.2.1')).toBe(false)
  expect(isPatchUpdate('nope', '0.2.1')).toBe(false)
})

test('parseVersion rejects what is not semver', () => {
  expect(parseVersion('v0.2.0')).toBeNull()
  expect(parseVersion('0.2')).toBeNull()
  expect(parseVersion('01.2.3')).toBeNull()
  expect(parseVersion('0.2.0-rc.1')).toEqual({ major: 0, minor: 2, patch: 0, pre: 'rc.1' })
})
