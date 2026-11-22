import { expect, test } from 'bun:test'
import { DEFAULT_PORT, MAX_PORT, parsePortValue } from './port'

test('a configured port is digits from 1 to 65535, and anything else is no port', () => {
  expect(parsePortValue('37811')).toBe(DEFAULT_PORT)
  expect(parsePortValue('1')).toBe(1)
  expect(parsePortValue(String(MAX_PORT))).toBe(MAX_PORT)
  for (const value of ['0', '65536', '-1', '3.5', ' 80', '80 ', '0x50', '1e3', '', 'port', undefined, null]) expect(parsePortValue(value)).toBeNull()
})
