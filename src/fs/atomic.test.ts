import { afterEach, expect, test } from 'bun:test'
import { fstatSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFileAtomic } from './atomic'

let dir = ''
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the folder is flushed only when asked, and never on win32', () => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-atomic-'))
  const path = join(dir, 'file')
  const synced: number[] = []
  const fsyncDir = (fd: number): void => {
    synced.push(fstatSync(fd).ino)
  }
  writeFileAtomic(path, 'one', 0o600, { fsyncDir })
  expect(synced).toEqual([])
  writeFileAtomic(path, 'two', 0o600, { syncDir: true, platform: 'win32', fsyncDir })
  expect(synced).toEqual([])
  writeFileAtomic(path, 'three', 0o600, { syncDir: true, platform: 'darwin', fsyncDir })
  expect(synced).toEqual([statSync(dir).ino])
  expect(readFileSync(path, 'utf8')).toBe('three')
})
