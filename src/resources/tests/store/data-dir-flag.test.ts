import { expect, test } from 'bun:test'
import { applyDataDirFlag } from './data-dir-flag'

test('the flag sets the data folder variable and the rest of argv is returned in order', () => {
  const env: Record<string, string | undefined> = {}
  expect(applyDataDirFlag(['--data-dir', '/x/My Memory', '--host', 'codex'], env)).toEqual(['--host', 'codex'])
  expect(env.KINFOLD_DATA_DIR).toBe('/x/My Memory')
  expect(applyDataDirFlag(['--data-dir=/y'], env)).toEqual([])
  expect(env.KINFOLD_DATA_DIR).toBe('/y')
})

test('argv without the flag leaves the environment alone', () => {
  const env: Record<string, string | undefined> = { KINFOLD_DATA_DIR: '/kept' }
  expect(applyDataDirFlag(['--host', 'codex'], env)).toEqual(['--host', 'codex'])
  expect(env.KINFOLD_DATA_DIR).toBe('/kept')
})

test('a missing or relative path is refused', () => {
  expect(() => applyDataDirFlag(['--data-dir'], {})).toThrow('absolute')
  expect(() => applyDataDirFlag(['--data-dir', 'rel'], {})).toThrow('absolute')
})
