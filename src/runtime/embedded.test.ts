import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDashboardAuth } from '../dashboard/auth'
import { EMBEDDED_ASSET_NAMES, PUBLIC_DIR, dashboardRoute, listAssets } from '../dashboard/routes'
import type { DashboardDeps } from '../dashboard/routes'
import { type FakeWorld, createWorld } from '../install/test-support'
import { runPlan } from '../install/plan'
import { sqlite3mcInstallActions } from '../install/sqlite3mc-install'
import { installEmbeddedVec0, vec0InstallActions } from '../install/vec0-install'
import { libDir, libraryFileName, manifestPath, readManifest } from '../sqlite/library'
import { SQLITE3MC_ZIP_SHA256 } from '../sqlite/release'
import { vec0Path } from '../vectors/extension'
import { type EmbeddedAssets, embeddedAssets, safeDashboardName } from './embedded'

const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')

const SQLITE3MC = new TextEncoder().encode('embedded sqlite3mc build')
const VEC0 = new TextEncoder().encode('embedded sqlite-vec build')
const NO_HEALTH = { up: false, reason: 'not running' } as const

/**
 * The assets a release program carries. Tests swap one recorded hash or the
 * bytes to prove the check, and the fake dashboard serves one page whatever the
 * route asks for, so a path check has to refuse before it is called.
 */
function fakeAssets(overrides: { sqlite3mcSha256?: string; vec0Sha256?: string; sqlite3mcSourceSha256?: string } = {}): EmbeddedAssets {
  return {
    sqlite3mc: {
      bytes: async () => SQLITE3MC,
      sha256: overrides.sqlite3mcSha256 ?? sha(SQLITE3MC),
      sourceSha256: overrides.sqlite3mcSourceSha256 ?? SQLITE3MC_ZIP_SHA256,
    },
    vec0: { bytes: async () => VEC0, sha256: overrides.vec0Sha256 ?? sha(VEC0) },
    dashboardFile: (name) => (name === 'index.html' || name.endsWith('.js') ? new Blob([`embedded ${name}`]) : null),
    opencodePlugin: async () => 'embedded opencode plugin',
  }
}

function dashboardDeps(assets: EmbeddedAssets | null): DashboardDeps {
  return {
    port: 1,
    auth: createDashboardAuth(),
    readBody: async () => ({ ok: true, value: {} }),
    log: () => {},
    assets,
  }
}

let w: FakeWorld
beforeEach(() => {
  w = createWorld({ withLibrary: false })
})
afterEach(async () => {
  await w.cleanup()
})

test('a developer checkout has no embedded assets', () => {
  expect(embeddedAssets()).toBeNull()
})

test('the embedded asset list stays equal to the dashboard public folder', () => {
  expect([...EMBEDDED_ASSET_NAMES].sort().join(',')).toBe([...listAssets(PUBLIC_DIR)].sort().join(','))
})

test('an embedded library is written under its hash with the manifest, with no compiler and no network', async () => {
  const assets = fakeAssets()
  const plan = sqlite3mcInstallActions(w.env, assets)
  expect(plan.restartDaemon).toBe(true)
  expect(plan.actions.map((action) => action.kind)).toEqual(['install-sqlite3mc-embedded'])

  let networkCalls = 0
  let builds = 0
  const env = {
    ...w.env,
    fetch: async () => {
      networkCalls += 1
      throw new Error('the embedded install must not download')
    },
    buildSqlite3mc: () => {
      builds += 1
      return ''
    },
  }
  await runPlan(env, plan.actions, false)

  const file = libraryFileName(sha(SQLITE3MC), 'darwin')!
  expect(new Uint8Array(readFileSync(join(libDir(w.dataDir), file)))).toEqual(SQLITE3MC)
  expect(readManifest(w.dataDir)).toEqual({ file, sha256: sha(SQLITE3MC), sourceSha256: SQLITE3MC_ZIP_SHA256 })
  expect(networkCalls).toBe(0)
  expect(builds).toBe(0)
})

test('a second install with the same hash plans no action', async () => {
  const assets = fakeAssets()
  await runPlan(w.env, sqlite3mcInstallActions(w.env, assets).actions, false)
  expect(sqlite3mcInstallActions(w.env, assets)).toEqual({ actions: [], restartDaemon: false })
})

test('a lib holding an older build gets the new file and a swapped manifest, and the daemon restarts', async () => {
  const older = sha('older sqlite3mc build')
  const olderFile = libraryFileName(older, 'darwin')!
  mkdirSync(libDir(w.dataDir), { recursive: true })
  writeFileSync(join(libDir(w.dataDir), olderFile), 'older sqlite3mc build')
  writeFileSync(manifestPath(w.dataDir), JSON.stringify({ file: olderFile, sha256: older, sourceSha256: SQLITE3MC_ZIP_SHA256 }))

  const plan = sqlite3mcInstallActions(w.env, fakeAssets())
  expect(plan.restartDaemon).toBe(true)
  expect(plan.actions.map((action) => action.kind)).toEqual(['install-sqlite3mc-embedded'])
  await runPlan(w.env, plan.actions, false)

  const file = libraryFileName(sha(SQLITE3MC), 'darwin')!
  expect(readManifest(w.dataDir)).toEqual({ file, sha256: sha(SQLITE3MC), sourceSha256: SQLITE3MC_ZIP_SHA256 })
  expect(readdirSync(libDir(w.dataDir)).sort()).toEqual([file, 'sqlite3mc.json'].sort())
})

test('an embedded library whose bytes do not match its recorded sha256 fails with a fixed error and writes nothing', async () => {
  const assets = fakeAssets({ sqlite3mcSha256: 'f'.repeat(64) })
  const plan = sqlite3mcInstallActions(w.env, assets)
  expect(plan.actions.map((action) => action.kind)).toEqual(['install-sqlite3mc-embedded'])
  await expect(runPlan(w.env, plan.actions, false)).rejects.toThrow('the embedded sqlite3mc build does not match its recorded sha256; nothing was written')
  expect(existsSync(manifestPath(w.dataDir))).toBe(false)
  expect(existsSync(libDir(w.dataDir)) ? readdirSync(libDir(w.dataDir)) : []).toEqual([])
})

test('an embedded sqlite-vec build is written once with no network, and a second plan does nothing', async () => {
  const assets = fakeAssets()
  const env = { ...w.env, platform: 'darwin' as const, arch: 'arm64' }
  const plan = vec0InstallActions(env, NO_HEALTH, assets)
  expect(plan.restartDaemon).toBe(true)
  expect(plan.actions.map((action) => action.kind)).toEqual(['install-vec0-embedded'])

  let networkCalls = 0
  await runPlan({ ...env, fetch: async () => (networkCalls += 1, new Response(null)) }, plan.actions, false)
  expect(networkCalls).toBe(0)
  expect(new Uint8Array(readFileSync(vec0Path(w.dataDir, 'darwin')))).toEqual(VEC0)
  expect(vec0InstallActions(env, NO_HEALTH, assets)).toEqual({ actions: [], restartDaemon: false })
})

test('an embedded sqlite-vec build whose bytes do not match its recorded sha256 fails with a fixed error and writes nothing', async () => {
  const assets = fakeAssets({ vec0Sha256: 'f'.repeat(64) })
  const env = { ...w.env, platform: 'darwin' as const, arch: 'arm64' }
  const plan = vec0InstallActions(env, NO_HEALTH, assets)
  await expect(runPlan(env, plan.actions, false)).rejects.toThrow('the embedded sqlite-vec build does not match its recorded sha256; nothing was written')
  expect(existsSync(vec0Path(w.dataDir, 'darwin'))).toBe(false)
})

test('an embedded dashboard page is served through the dashboard routes', async () => {
  const response = await dashboardRoute(new Request('http://127.0.0.1:1/dashboard/'), '/dashboard/', dashboardDeps(fakeAssets()))
  expect(response?.status).toBe(200)
  expect(await response?.text()).toBe('embedded index.html')
})

test('developer mode serves the dashboard page from PUBLIC_DIR', async () => {
  const response = await dashboardRoute(new Request('http://127.0.0.1:1/dashboard/'), '/dashboard/', dashboardDeps(null))
  expect(response?.status).toBe(200)
  expect(await response?.text()).toBe(readFileSync(join(PUBLIC_DIR, 'index.html'), 'utf8'))
})

test('a dashboard path with .., an absolute path or a backslash is refused in both modes', async () => {
  for (const name of ['../index.html', '..\\index.html', '/etc/passwd', 'index/../../index.html', '..']) {
    expect(safeDashboardName(name)).toBe(false)
  }
  const hostile: EmbeddedAssets = {
    ...fakeAssets(),
    dashboardFile: () => new Blob(['anything']),
  }
  for (const assets of [hostile, null]) {
    for (const path of ['/dashboard/assets/../index.html', '/dashboard/assets/..%2findex.html', '/dashboard/assets/..\\index.html']) {
      expect(await dashboardRoute(new Request('http://127.0.0.1:1/dashboard/'), path, dashboardDeps(assets))).toBeNull()
    }
  }
})

test('installEmbeddedVec0 is the direct entry point the plan uses', async () => {
  const path = vec0Path(w.dataDir, 'linux')
  await installEmbeddedVec0(w.env, path, fakeAssets().vec0)
  expect(new Uint8Array(readFileSync(path))).toEqual(VEC0)
})
