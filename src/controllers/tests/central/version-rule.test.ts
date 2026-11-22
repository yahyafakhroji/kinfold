import { expect, test } from 'bun:test'
import { versionGap } from '../../central/version-rule'

test('the same major.minor is compatible whatever the patch', () => {
  expect(versionGap('0.6.0', '0.6.3')).toBeNull()
  expect(versionGap('1.2.9', '1.2.0')).toBeNull()
  expect(versionGap('0.6.0-beta.1', '0.6.0')).toBeNull()
})

test('a different minor or major names which side is older', () => {
  expect(versionGap('0.6.2', '0.7.0')).toEqual({ older: 'device', hub: '0.7.0', device: '0.6.2' })
  expect(versionGap('0.7.0', '0.6.2')).toEqual({ older: 'hub', hub: '0.6.2', device: '0.7.0' })
  expect(versionGap('2.0.0', '1.9.9')).toEqual({ older: 'hub', hub: '1.9.9', device: '2.0.0' })
})

test('a version that does not parse is a gap on that side', () => {
  expect(versionGap('nonsense', '0.6.0')).toEqual({ older: 'device', hub: '0.6.0', device: 'nonsense' })
  expect(versionGap('0.6.0', '')).toEqual({ older: 'hub', hub: '', device: '0.6.0' })
})

test('two development builds from a checkout are compatible with each other only', () => {
  expect(versionGap('0.0.0-dev', '0.0.0-dev')).toBeNull()
  expect(versionGap('0.0.0-dev', '0.6.0')).toEqual({ older: 'device', hub: '0.6.0', device: '0.0.0-dev' })
})
