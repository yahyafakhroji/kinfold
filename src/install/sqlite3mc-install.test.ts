import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BuildInput } from '../sqlite/build'
import { checkLibrary, libDir, libraryFileName, manifestPath, readManifest } from '../sqlite/library'
import { SQLITE3MC_ZIP_URL } from '../sqlite/release'
import type { InstallEnv } from './env'
import { hasBuiltLibrary, installSqlite3mc, sqlite3mcInstallActions } from './sqlite3mc-install'
import { type FakeWorld, createWorld, placeBuiltLibrary } from './test-support'

let w: FakeWorld
beforeEach(() => {
  w = createWorld({ withLibrary: false })
})
afterEach(() => w.cleanup())

const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
/** Stands in for the release zip; the tests pin its hash in place of the real one. */
const ZIP = new TextEncoder().encode('amalgamation zip')

function fakeBuild(input: BuildInput): string {
  writeFileSync(input.output, 'built library', { mode: 0o755 })
  return sha('built library')
}

/** Serves `zip` for the pinned URL and records each build it is asked for. */
function world(options: { zip?: Uint8Array; status?: number; build?: (input: BuildInput) => string } = {}) {
  const urls: string[] = []
  const builds: BuildInput[] = []
  const env: InstallEnv = {
    ...w.env,
    platform: 'darwin',
    fetch: async (url) => (urls.push(url), new Response(options.zip ?? ZIP, { status: options.status ?? 200 })),
    buildSqlite3mc: (input) => (builds.push(input), (options.build ?? fakeBuild)(input)),
  }
  return { env, urls, builds, dir: libDir(w.dataDir) }
}

const leftovers = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith('.sqlite3mc-build')) : [])

test('the plan builds when no manifest names a matching build from the pinned source, and then restarts the daemon', () => {
  const { env, dir } = world()
  expect(sqlite3mcInstallActions(env)).toEqual({ actions: [{ kind: 'install-sqlite3mc', path: dir }], restartDaemon: true })
  placeBuiltLibrary(w.dataDir, 'darwin')
  expect(sqlite3mcInstallActions(env)).toEqual({ actions: [], restartDaemon: false })
  // The same build, recorded as made from another zip: a pin bump rebuilds.
  const manifest = readManifest(w.dataDir)!
  writeFileSync(manifestPath(w.dataDir), JSON.stringify({ ...manifest, sourceSha256: 'b'.repeat(64) }))
  expect(hasBuiltLibrary(w.dataDir)).toBe(false)
  expect(sqlite3mcInstallActions(env).actions).toHaveLength(1)
})

test('a platform with no build plans nothing and says so', () => {
  expect(sqlite3mcInstallActions({ ...w.env, platform: 'aix' as NodeJS.Platform }).actions).toEqual([])
  expect(w.out.some((line) => line.includes('no sqlite3mc build for aix'))).toBe(true)
})

test('the build lands 0600 under its own hash, the manifest names it, and old builds and build directories go', async () => {
  const { env, urls, builds, dir } = world()
  mkdirSync(join(dir, '.sqlite3mc-build-999', 'src'), { recursive: true })
  writeFileSync(join(dir, 'libsqlite3mc-0000000000000000.dylib'), 'an older build')
  writeFileSync(join(dir, 'vec0.dylib'), 'unrelated')
  await installSqlite3mc(env, dir, sha(ZIP))
  expect(urls).toEqual([SQLITE3MC_ZIP_URL])
  expect(builds).toHaveLength(1)
  expect(builds[0]!.zip).toEqual(ZIP)
  const file = libraryFileName(sha('built library'), 'darwin')!
  expect(readManifest(w.dataDir)).toEqual({ file, sha256: sha('built library'), sourceSha256: sha(ZIP) })
  expect(readFileSync(join(dir, file), 'utf8')).toBe('built library')
  expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600)
  expect(statSync(manifestPath(w.dataDir)).mode & 0o777).toBe(0o600)
  expect(readdirSync(dir).sort()).toEqual([file, 'sqlite3mc.json', 'vec0.dylib'].sort())
  expect(checkLibrary(w.dataDir).ok).toBe(true)
})

test('a download that is not the pinned zip stops before any build, and nothing is written', async () => {
  const { env, builds, dir } = world({ zip: new TextEncoder().encode('not the release') })
  await expect(installSqlite3mc(env, dir, sha(ZIP))).rejects.toThrow('does not match the pinned sha256; nothing was written')
  expect(builds).toHaveLength(0)
  expect(existsSync(manifestPath(w.dataDir))).toBe(false)
})

test('a failed download writes nothing', async () => {
  const { env, dir } = world({ status: 404 })
  await expect(installSqlite3mc(env, dir, sha(ZIP))).rejects.toThrow('answered 404; nothing was written')
  expect(existsSync(manifestPath(w.dataDir))).toBe(false)
})

test('a build that fails leaves the current build and manifest alone, and no build directory', async () => {
  placeBuiltLibrary(w.dataDir, 'darwin')
  const before = readFileSync(manifestPath(w.dataDir), 'utf8')
  const { env, dir } = world({ build: () => { throw new Error('cc: command not found') } })
  await expect(installSqlite3mc(env, dir, sha(ZIP))).rejects.toThrow('could not build sqlite3mc (cc: command not found); nothing was written')
  expect(readFileSync(manifestPath(w.dataDir), 'utf8')).toBe(before)
  expect(checkLibrary(w.dataDir).ok).toBe(true)
  expect(leftovers(dir)).toEqual([])
})
