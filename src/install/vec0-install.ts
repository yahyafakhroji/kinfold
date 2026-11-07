// `kinfold install` puts a sqlite-vec build in <dataDir>/lib. A checkout
// downloads the pinned tarball from the GitHub release; a compiled program
// carries its own build and writes it after checking the recorded hash. The
// downloaded path checks the tarball hash, then the member's own hash before
// it is written 0600; the embedded path checks the bytes before the file is
// touched. A wrong hash stops the plan with nothing written. The daemon loads
// the member through sqlite3mc (src/install/sqlite3mc-install.ts), which
// allows extensions, so no other SQLite is needed.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { type EmbeddedAssets, embeddedAssets } from '../runtime/embedded'
import { hasLibraryBuild } from '../sqlite/library'
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import { sha256File, vec0FileName, vec0Path } from '../vectors/extension'
import { VEC0_VERSION, type Vec0Asset, vec0AssetFor } from '../vectors/vec0-release'
import type { Health } from './daemon-client'
import type { InstallEnv } from './env'
import { writeFileAtomic } from './files'
import type { Action } from './plan'
import { hasBuiltLibrary } from './sqlite3mc-install'

export const VEC0_DOWNLOAD_TIMEOUT_MS = 60_000
/** The release tarball is about 50 KB; anything far larger is not it. */
export const MAX_VEC0_TARBALL_BYTES = 5_000_000
/** Fixed, with no hashes in it: a mismatch is a build problem, not something a user can inspect. */
export const EMBEDDED_VEC0_SHA_MISMATCH = 'the embedded sqlite-vec build does not match its recorded sha256; nothing was written'

const TAR_BLOCK = 512

export interface Vec0Plan {
  actions: Action[]
  /** The daemon must restart to load sqlite-vec: it was just installed, or the running daemon started without it. */
  restartDaemon: boolean
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function hasVec0Build(path: string, sha256: string): boolean {
  try {
    return existsSync(path) && sha256File(path) === sha256
  } catch {
    return false
  }
}

function hasPinnedBuild(path: string, asset: Vec0Asset): boolean {
  return hasVec0Build(path, asset.fileSha256)
}

/** The bytes of one regular-file member of an uncompressed ustar archive, by its base name; null when absent. */
export function tarMember(archive: Uint8Array, name: string): Uint8Array | null {
  const text = (start: number, length: number) => new TextDecoder().decode(archive.subarray(start, start + length)).replace(/\0.*$/s, '')
  for (let offset = 0; offset + TAR_BLOCK <= archive.length;) {
    const memberName = text(offset, 100)
    if (memberName === '') return null
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) return null
    const type = text(offset + 156, 1)
    const start = offset + TAR_BLOCK
    if ((type === '0' || type === '') && memberName.replace(/^(\.\/)+/, '') === name) {
      return start + size <= archive.length ? archive.slice(start, start + size) : null
    }
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  return null
}

/** Download, check, unpack, check, write. Throws, so the plan stops, on any mismatch. */
export async function installVec0(env: InstallEnv, path: string, asset: Vec0Asset): Promise<void> {
  let response: Response
  try {
    response = await env.fetch(asset.url, { redirect: 'follow', signal: AbortSignal.timeout(VEC0_DOWNLOAD_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new Error(`could not download sqlite-vec (${error instanceof Error ? error.name : 'error'}); nothing was written`)
  }
  if (!response.ok) throw new Error(`the sqlite-vec download answered ${response.status}; nothing was written`)
  const tarball = new Uint8Array(await response.arrayBuffer())
  if (tarball.length > MAX_VEC0_TARBALL_BYTES) throw new Error('the sqlite-vec download is far larger than the release; nothing was written')
  if (sha256(tarball) !== asset.tarballSha256) throw new Error('the sqlite-vec download does not match the pinned sha256; nothing was written')
  const member = tarMember(Bun.gunzipSync(tarball), asset.member)
  if (member === null) throw new Error(`the sqlite-vec tarball has no ${asset.member}; nothing was written`)
  if (sha256(member) !== asset.fileSha256) throw new Error(`${asset.member} does not match the pinned sha256; nothing was written`)
  mkdirSync(dirname(path), { recursive: true, mode: DATA_DIR_MODE })
  writeFileAtomic(path, member, DATA_FILE_MODE)
}

export function describeEmbeddedVec0Install(path: string): string {
  return `write the embedded sqlite-vec ${VEC0_VERSION} build to ${path} (mode 0600) after checking it against its recorded sha256; no download`
}

/** The program's own build: checked against its recorded hash before anything is written. */
export async function installEmbeddedVec0(env: InstallEnv, path: string, asset: EmbeddedAssets['vec0']): Promise<void> {
  const bytes = await asset.bytes()
  if (sha256(bytes) !== asset.sha256) throw new Error(EMBEDDED_VEC0_SHA_MISMATCH)
  mkdirSync(dirname(path), { recursive: true, mode: DATA_DIR_MODE })
  writeFileAtomic(path, bytes, DATA_FILE_MODE)
}

function hasSqlite3mc(env: InstallEnv, assets: EmbeddedAssets | null): boolean {
  return assets === null
    ? hasBuiltLibrary(env.dataDir)
    : hasLibraryBuild(env.dataDir, assets.sqlite3mc.sha256, assets.sqlite3mc.sourceSha256)
}

/** `kinfold status`: what the daemon reports, else what is missing. Read-only: a hash of the file, no load. */
export function vectorStatusLine(env: InstallEnv, health: Health, assets: EmbeddedAssets | null = embeddedAssets()): string {
  const arch = env.arch ?? process.arch
  const asset = vec0AssetFor(env.platform, arch)
  if (assets === null && asset === null) return `semantic search: off (no pinned sqlite-vec build for ${env.platform}-${arch})`
  const path = vec0Path(env.dataDir, env.platform)
  const expected = assets === null ? asset!.fileSha256 : assets.vec0.sha256
  const missing = [
    ...(hasSqlite3mc(env, assets) ? [] : ['the sqlite3mc library (kinfold install)']),
    ...(hasVec0Build(path, expected) ? [] : [`sqlite-vec ${VEC0_VERSION} (kinfold install)`]),
  ]
  if (health.up && health.vectorSearch === 'on') return 'semantic search: on'
  if (missing.length > 0) return `semantic search: off; missing ${missing.join(' and ')}`
  return health.up ? 'semantic search: off in the running daemon; restart it (kinfold install restarts it)' : 'semantic search: ready; the daemon is down'
}

function alreadyInstalled(env: InstallEnv, path: string, health: Health): Vec0Plan {
  env.out(`semantic search: sqlite-vec ${VEC0_VERSION} already at ${path}`)
  const stale = health.up && health.vectorSearch === 'off'
  if (stale) env.out('semantic search: the running daemon started without it, so it is restarted')
  return { actions: [], restartDaemon: stale }
}

/** The install step, plus notes on what search still needs. */
export function vec0InstallActions(env: InstallEnv, health: Health, assets: EmbeddedAssets | null = embeddedAssets()): Vec0Plan {
  const arch = env.arch ?? process.arch
  if (vec0FileName(env.platform) === null) {
    env.out(`semantic search: no sqlite-vec build for ${env.platform}; search stays keyword-only`)
    return { actions: [], restartDaemon: false }
  }
  const path = vec0Path(env.dataDir, env.platform)
  if (assets !== null) {
    if (hasVec0Build(path, assets.vec0.sha256)) return alreadyInstalled(env, path, health)
    return { actions: [{ kind: 'install-vec0-embedded', path, asset: assets.vec0 }], restartDaemon: true }
  }
  const asset = vec0AssetFor(env.platform, arch)
  if (asset === null) {
    env.out(`semantic search: no pinned sqlite-vec build for ${env.platform}-${arch}; search stays keyword-only`)
    return { actions: [], restartDaemon: false }
  }
  if (hasPinnedBuild(path, asset)) return alreadyInstalled(env, path, health)
  return { actions: [{ kind: 'install-vec0', path, asset }], restartDaemon: true }
}
