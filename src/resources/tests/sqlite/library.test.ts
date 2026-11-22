import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLITE3MC_LIB_ENV, checkLibrary, libDir, libraryFileName, libraryFor, manifestPath, readManifest } from '../../sqlite/library'

let dataDir: string
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'sam-lib-'))
  mkdirSync(libDir(dataDir))
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

const SOURCE = 'a'.repeat(64)
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** A build file with `bytes`, and a manifest that records `recorded` as its hash. */
function place(bytes: string, recorded: string = sha(bytes)): string {
  const file = libraryFileName(sha(bytes), 'darwin')!
  writeFileSync(join(libDir(dataDir), file), bytes)
  writeFileSync(manifestPath(dataDir), JSON.stringify({ file, sha256: recorded, sourceSha256: SOURCE }))
  return file
}

test('a build is named by its hash, per platform', () => {
  expect(libraryFileName(sha('x'), 'darwin')).toBe(`libsqlite3mc-${sha('x').slice(0, 16)}.dylib`)
  expect(libraryFileName(sha('x'), 'linux')).toMatch(/\.so$/)
  expect(libraryFileName(sha('x'), 'win32')).toMatch(/\.dll$/)
  expect(libraryFileName(sha('x'), 'aix')).toBeNull()
})

test('the manifest names the build that matches its hash', () => {
  const file = place('library bytes')
  const result = checkLibrary(dataDir)
  expect(result).toEqual({ ok: true, path: join(libDir(dataDir), file), manifest: { file, sha256: sha('library bytes'), sourceSha256: SOURCE } })
})

test('no manifest, a missing file, or a hash that does not match each give a reason that says to run kinfold install', () => {
  expect(checkLibrary(dataDir)).toEqual({ ok: false, reason: 'sqlite3mc library is not installed; run kinfold install' })
  const file = place('library bytes', sha('other bytes'))
  expect(checkLibrary(dataDir)).toMatchObject({ ok: false, reason: expect.stringContaining('does not match its recorded hash') })
  rmSync(join(libDir(dataDir), file))
  expect(checkLibrary(dataDir)).toMatchObject({ ok: false, reason: expect.stringContaining('is missing') })
})

test('a manifest naming a path, or with a malformed hash, is not read at all', () => {
  for (const file of ['../../etc/passwd', 'libsqlite3mc-0123456789abcdef.dylib/../x', 'evil.dylib']) {
    writeFileSync(manifestPath(dataDir), JSON.stringify({ file, sha256: sha('x'), sourceSha256: SOURCE }))
    expect(readManifest(dataDir)).toBeNull()
  }
  writeFileSync(manifestPath(dataDir), JSON.stringify({ file: libraryFileName(sha('x'), 'darwin'), sha256: 'nope', sourceSha256: SOURCE }))
  expect(readManifest(dataDir)).toBeNull()
  writeFileSync(manifestPath(dataDir), 'not json')
  expect(readManifest(dataDir)).toBeNull()
})

test('libraryFor uses the override unchecked, else the checked manifest build, else throws a library error', () => {
  const override = join(dataDir, 'custom.dylib')
  writeFileSync(override, 'x')
  expect(libraryFor(join(dataDir, 'memory.db'), { [SQLITE3MC_LIB_ENV]: override })).toBe(override)
  expect(() => libraryFor(join(dataDir, 'memory.db'), { [SQLITE3MC_LIB_ENV]: join(dataDir, 'gone.dylib') })).toThrow('names a missing file')
  expect(() => libraryFor(join(dataDir, 'memory.db'), {})).toThrow(expect.objectContaining({ kind: 'library', code: 'SQLITE_CANTOPEN' }))
  const file = place('library bytes')
  expect(libraryFor(join(dataDir, 'memory.db'), {})).toBe(join(libDir(dataDir), file))
})

test('outside tests the override is not read: no variable can point the program, and so the database key, at another library', () => {
  const override = join(dataDir, 'planted.dylib')
  writeFileSync(override, 'x')
  const production = false
  expect(() => libraryFor(join(dataDir, 'memory.db'), { [SQLITE3MC_LIB_ENV]: override }, production)).toThrow(`${SQLITE3MC_LIB_ENV} is set but is read only under NODE_ENV=test`)
  expect(() => libraryFor(join(dataDir, 'memory.db'), { SAM_SQLITE3MC_LIB: override }, production)).toThrow(expect.objectContaining({ kind: 'library' }))
  const file = place('library bytes')
  expect(libraryFor(join(dataDir, 'memory.db'), { [SQLITE3MC_LIB_ENV]: override }, production)).toBe(join(libDir(dataDir), file))
  // A child a test starts says it is one in the environment it is handed.
  expect(libraryFor(join(dataDir, 'memory.db'), { [SQLITE3MC_LIB_ENV]: override, NODE_ENV: 'test' }, undefined)).toBe(override)
})
