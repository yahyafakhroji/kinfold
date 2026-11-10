import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expectedMode, scanDataDirModes } from './permissions'
import { posixOnly } from '../../test/platform-guards'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function dataDirWithProgram(programMode: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinfold-perm-'))
  roots.push(dir)
  chmodSync(dir, 0o700)
  mkdirSync(join(dir, 'bin'), { mode: 0o700 })
  chmodSync(join(dir, 'bin'), 0o700)
  writeFileSync(join(dir, 'bin', 'kinfold'), 'program')
  chmodSync(join(dir, 'bin', 'kinfold'), programMode)
  return dir
}

test('expectedMode gives 0755 to the program in either spelling and nothing else', () => {
  expect(expectedMode('bin/kinfold', 'file')).toBe(0o755)
  expect(expectedMode('bin/kinfold.exe', 'file')).toBe(0o755)
  expect(expectedMode('bin\\kinfold.exe', 'file')).toBe(0o755)
  expect(expectedMode('bin/other', 'file')).toBe(0o600)
  expect(expectedMode('kinfold', 'file')).toBe(0o600)
  expect(expectedMode('lib/bin/kinfold', 'file')).toBe(0o600)
  expect(expectedMode('store.db', 'file')).toBe(0o600)
})

test('expectedMode gives 0700 to every directory, bin included', () => {
  expect(expectedMode('.', 'dir')).toBe(0o700)
  expect(expectedMode('bin', 'dir')).toBe(0o700)
  expect(expectedMode('bin/kinfold', 'dir')).toBe(0o700)
})

posixOnly('file modes')('a program at 0755 needs no change', () => {
  expect(scanDataDirModes(dataDirWithProgram(0o755)).changes).toEqual([])
})

posixOnly('file modes')('a program at 0600 is planned back to 0755', () => {
  expect(scanDataDirModes(dataDirWithProgram(0o600)).changes).toEqual([{ path: 'bin/kinfold', kind: 'file', from: 0o600, to: 0o755 }])
})

posixOnly('file modes')('update temp programs are skipped by the scan', () => {
  const dir = dataDirWithProgram(0o755)
  writeFileSync(join(dir, 'bin', '.kinfold-update-abc'), 'temp')
  chmodSync(join(dir, 'bin', '.kinfold-update-abc'), 0o755)
  const scan = scanDataDirModes(dir)
  expect(scan.changes).toEqual([])
  expect(scan.checked).toBe(3)
})
