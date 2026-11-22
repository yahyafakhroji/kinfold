import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type TempStore, openTempStore } from '../observer/test-support'
import { loadVec0, vec0Path } from './extension'
import { VEC0_ASSETS, vec0AssetFor } from './vec0-release'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-vec0-')
})
afterEach(() => temp.cleanup())

test('every Kinfold target has a pinned build', () => {
  for (const target of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
    const [platform, arch] = target.split('-') as [string, string]
    expect({ target, sha: vec0AssetFor(platform, arch)?.fileSha256 }).toEqual({ target, sha: expect.stringMatching(/^[0-9a-f]{64}$/) })
  }
  expect(Object.keys(VEC0_ASSETS).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'])
  expect(vec0AssetFor('darwin', 'ia32')).toBeNull()
})

test('vec0 does not load without a pinned build for the arch, without the file, or when the file is not the pinned build', () => {
  const db = temp.store.db
  expect(loadVec0(db, temp.dataDir, 'darwin', 'ia32')).toMatchObject({ ok: false, reason: expect.stringContaining('darwin-ia32') })
  expect(loadVec0(db, temp.dataDir, 'darwin', 'arm64')).toMatchObject({ ok: false, reason: expect.stringContaining('is missing; run kinfold install') })
  mkdirSync(join(temp.dataDir, 'lib'), { recursive: true })
  writeFileSync(vec0Path(temp.dataDir, 'darwin'), 'not the release')
  expect(loadVec0(db, temp.dataDir, 'darwin', 'arm64')).toMatchObject({ ok: false, reason: expect.stringContaining('does not match the pinned') })
})

test('the file name follows the platform', () => {
  expect(vec0Path(temp.dataDir, 'darwin')).toEndWith('vec0.dylib')
  expect(vec0Path(temp.dataDir, 'linux')).toEndWith('vec0.so')
  expect(vec0Path(temp.dataDir, 'win32')).toEndWith('vec0.dll')
})
