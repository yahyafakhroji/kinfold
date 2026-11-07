import { expect, test } from 'bun:test'
import { isInBinFolder } from './permissions'

test('the bin folder is matched with either separator', () => {
  expect(isInBinFolder('bin')).toBe(true)
  expect(isInBinFolder('bin/kinfold')).toBe(true)
  expect(isInBinFolder('bin\\kinfold.exe')).toBe(true)
  expect(isInBinFolder('binary/kinfold')).toBe(false)
  expect(isInBinFolder('lib/kinfold')).toBe(false)
  expect(isInBinFolder('.')).toBe(false)
})
