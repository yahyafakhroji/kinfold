import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type TempStore, openTempStore } from '../observer/test-support'
import { loadVec0, vec0Path } from './extension'
import { vec0AssetFor } from './vec0-release'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-vec0-')
})
afterEach(() => temp.cleanup())

test('only darwin-arm64 has a pinned build', () => {
  expect(vec0AssetFor('darwin', 'arm64')?.dylibSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(vec0AssetFor('darwin', 'x64')).toBeNull()
  expect(vec0AssetFor('linux', 'arm64')).toBeNull()
})

test('vec0 does not load without a pinned build for the arch, without the file, or when the file is not the pinned build', () => {
  const db = temp.store.db
  expect(loadVec0(db, temp.dataDir, 'darwin', 'x64')).toMatchObject({ ok: false, reason: expect.stringContaining('darwin-x64') })
  expect(loadVec0(db, temp.dataDir, 'darwin', 'arm64')).toMatchObject({ ok: false, reason: expect.stringContaining('is missing; run sam install') })
  mkdirSync(join(temp.dataDir, 'lib'), { recursive: true })
  writeFileSync(vec0Path(temp.dataDir), 'not the release')
  expect(loadVec0(db, temp.dataDir, 'darwin', 'arm64')).toMatchObject({ ok: false, reason: expect.stringContaining('does not match the pinned') })
})
