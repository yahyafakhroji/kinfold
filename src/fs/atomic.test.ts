import { afterEach, expect, test } from 'bun:test'
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPlan } from '../install/plan'
import { createWorld } from '../install/test-support'
import { KEY_STORE_FILE, readKeyStoreRecord } from '../secrets/key-store-record'
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

test('key-store.json round-trips at 0600 and the folder is flushed', async () => {
  const world = createWorld({ withLibrary: false })
  try {
    mkdirSync(world.dataDir, { recursive: true, mode: 0o700 })
    const synced: number[] = []
    const env = { ...world.env, fsyncDir: (fd: number): void => void synced.push(fstatSync(fd).ino) }
    const path = join(world.dataDir, KEY_STORE_FILE)
    await runPlan(env, [{ kind: 'record-key-store', path, record: { store: 'keychain', chosenAt: 1_792_900_000_000 } }], false)
    expect(world.out).toContain(`  1. record the key store (keychain) in ${path} (mode 0600)  [done]`)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')) as object)).toEqual(['store', 'chosenAt'])
    expect(readKeyStoreRecord(world.dataDir)).toEqual({ state: 'present', record: { store: 'keychain', chosenAt: 1_792_900_000_000 } })
    expect(synced).toEqual([statSync(world.dataDir).ino])
  } finally {
    await world.cleanup()
  }
})
