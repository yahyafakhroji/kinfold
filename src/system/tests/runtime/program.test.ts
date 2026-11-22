import { describe, expect, test } from 'bun:test'
import { isCompiledProgram } from './program'

describe('isCompiledProgram', () => {
  test('recognises the macOS and Linux virtual path', () => {
    expect(isCompiledProgram('/$bunfs/root/kinfold')).toBe(true)
    expect(isCompiledProgram('/$bunfs/root/src/cli/kinfold.ts')).toBe(true)
  })

  test('recognises both spellings of the Windows virtual path', () => {
    expect(isCompiledProgram('B:\\~BUN\\root\\src\\cli\\kinfold.ts')).toBe(true)
    // Bun 1.4 on Windows reports Bun.main with forward slashes.
    expect(isCompiledProgram('B:/~BUN/root/kinfold.exe')).toBe(true)
  })

  test('a checkout run is not compiled on any OS', () => {
    expect(isCompiledProgram('/Users/me/kinfold/src/cli/kinfold.ts')).toBe(false)
    expect(isCompiledProgram('/home/me/kinfold/src/cli/kinfold.ts')).toBe(false)
    expect(isCompiledProgram('C:\\Users\\me\\kinfold\\src\\cli\\kinfold.ts')).toBe(false)
    expect(isCompiledProgram('B:/kinfold/src/cli/kinfold.ts')).toBe(false)
  })
})
