// `kinfold install` builds the pinned sqlite3mc on this machine (the user
// chose local builds for now). The zip is fetched from the GitHub release and
// its sha256 checked before anything is read from it; the amalgamation is
// compiled with the system C compiler in an empty directory inside lib/. The
// build lands under its own hash-named file, then lib/sqlite3mc.json is
// replaced atomically, so a process opening the store sees the old build or
// the new one (src/sqlite/library.ts). Every process opens the store through
// this library, so the daemon restarts after a new build.

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { type EmbeddedAssets, embeddedAssets } from '../runtime/embedded'
import { type BuildInput, buildSqlite3mc } from '../sqlite/build'
import { type LibraryManifest, checkLibrary, hasLibraryBuild, installLibraryBuild, libDir, libraryFileName, manifestPath, sha256File } from '../sqlite/library'
import { MAX_SQLITE3MC_ZIP_BYTES, SQLITE3MC_VERSION, SQLITE3MC_ZIP_SHA256, SQLITE3MC_ZIP_URL, sqlite3mcLibraryExtension } from '../sqlite/release'
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import type { InstallEnv } from './env'
import { writeFileAtomic } from './files'
import type { Action } from './plan'

export const SQLITE3MC_DOWNLOAD_TIMEOUT_MS = 60_000
const BUILD_DIR_PREFIX = '.sqlite3mc-build-'

export interface Sqlite3mcPlan {
  actions: Action[]
  /** The daemon opens the store through this library, so it restarts once a new build is in place. */
  restartDaemon: boolean
}

/** The manifest's build is there, matches its hash, and came from the pinned source. */
export function hasBuiltLibrary(dataDir: string, pinnedSha256: string = SQLITE3MC_ZIP_SHA256): boolean {
  const result = checkLibrary(dataDir)
  return result.ok && result.manifest.sourceSha256 === pinnedSha256
}

export function sqlite3mcInstallActions(env: InstallEnv, assets: EmbeddedAssets | null = embeddedAssets()): Sqlite3mcPlan {
  if (sqlite3mcLibraryExtension(env.platform) === null) {
    env.out(`database library: no sqlite3mc build for ${env.platform}`)
    return { actions: [], restartDaemon: false }
  }
  const dir = libDir(env.dataDir)
  if (assets !== null) {
    if (hasLibraryBuild(env.dataDir, assets.sqlite3mc.sha256, assets.sqlite3mc.sourceSha256)) {
      env.out(`database library: embedded sqlite3mc ${SQLITE3MC_VERSION} already in ${dir}`)
      return { actions: [], restartDaemon: false }
    }
    return { actions: [{ kind: 'install-sqlite3mc-embedded', path: dir, asset: assets.sqlite3mc }], restartDaemon: true }
  }
  if (hasBuiltLibrary(env.dataDir)) {
    env.out(`database library: sqlite3mc ${SQLITE3MC_VERSION} already in ${dir}`)
    return { actions: [], restartDaemon: false }
  }
  return { actions: [{ kind: 'install-sqlite3mc', path: dir }], restartDaemon: true }
}

export function describeSqlite3mcInstall(dir: string): string {
  return `download ${SQLITE3MC_ZIP_URL}, check it against the pinned sha256, build sqlite3mc ${SQLITE3MC_VERSION} with the system C compiler (about 10 s),`
    + ` and write it to ${dir} (mode 0600) with ${join(dir, 'sqlite3mc.json')} naming it`
}

export function describeEmbeddedSqlite3mcInstall(dir: string): string {
  return `write the embedded sqlite3mc ${SQLITE3MC_VERSION} build to ${dir} (mode 0600) after checking it against its recorded sha256,`
    + ` with ${join(dir, 'sqlite3mc.json')} naming it; no compiler, no download`
}

/** The program's own build: checked against its recorded hash, then placed exactly as a local build is. */
export async function installEmbeddedSqlite3mc(env: InstallEnv, dir: string, asset: EmbeddedAssets['sqlite3mc']): Promise<void> {
  installLibraryBuild(dir, await asset.bytes(), asset.sha256, asset.sourceSha256, env.platform, env.out)
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // Best effort: a leftover file only costs disk space.
  }
}

/** Download, check, build, place, then point the manifest at it. Throws, so the plan stops, on any failure; the manifest only ever names a complete build. */
export async function installSqlite3mc(env: InstallEnv, dir: string, pinnedSha256: string = SQLITE3MC_ZIP_SHA256): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE })
  for (const name of readdirSync(dir)) if (name.startsWith(BUILD_DIR_PREFIX)) removeQuietly(join(dir, name))
  let response: Response
  try {
    response = await env.fetch(SQLITE3MC_ZIP_URL, { redirect: 'follow', signal: AbortSignal.timeout(SQLITE3MC_DOWNLOAD_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new Error(`could not download sqlite3mc (${error instanceof Error ? error.name : 'error'}); nothing was written`)
  }
  if (!response.ok) throw new Error(`the sqlite3mc download answered ${response.status}; nothing was written`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_SQLITE3MC_ZIP_BYTES) {
    throw new Error('the sqlite3mc download is far larger than the release; nothing was written')
  }
  const zip = new Uint8Array(await response.arrayBuffer())
  if (zip.length > MAX_SQLITE3MC_ZIP_BYTES) throw new Error('the sqlite3mc download is far larger than the release; nothing was written')
  if (createHash('sha256').update(zip).digest('hex') !== pinnedSha256) throw new Error('the sqlite3mc download does not match the pinned sha256; nothing was written')
  const workDir = join(dir, `${BUILD_DIR_PREFIX}${process.pid}`)
  const built = join(workDir, 'out', 'library')
  try {
    mkdirSync(dirname(built), { recursive: true, mode: DATA_DIR_MODE })
    const build = env.buildSqlite3mc ?? ((input: BuildInput) => buildSqlite3mc(input))
    try {
      build({ zip, workDir: join(workDir, 'src'), output: built, platform: env.platform })
    } catch (error: unknown) {
      throw new Error(`could not build sqlite3mc (${error instanceof Error ? error.message : 'error'}); nothing was written`)
    }
    const sha256 = sha256File(built)
    const file = libraryFileName(sha256, env.platform)!
    chmodSync(built, DATA_FILE_MODE)
    renameSync(built, join(dir, file))
    const manifest: LibraryManifest = { file, sha256, sourceSha256: pinnedSha256 }
    writeFileAtomic(manifestPath(env.dataDir), `${JSON.stringify(manifest)}\n`, DATA_FILE_MODE)
    // Older builds go once nothing names them; a process that already loaded one keeps its mapping.
    for (const name of readdirSync(dir)) if (name.startsWith('libsqlite3mc') && name !== file) removeQuietly(join(dir, name))
  } finally {
    removeQuietly(workDir)
  }
}
