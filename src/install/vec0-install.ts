// `sam install` puts the pinned sqlite-vec build in <dataDir>/lib (P2-A; the
// user chose an installer download over an npm dependency). The tarball is
// fetched from the GitHub release, its sha256 checked against the hash in
// src/vectors/vec0-release.ts, unpacked in process (gunzip, then a ustar
// walk for the one member, so no tar subprocess and no member name ever
// becomes a path), and the dylib's own hash checked before it is written
// 0600. A wrong hash stops the plan with nothing written. The daemon loads
// it through sqlite3mc (src/install/sqlite3mc-install.ts), which allows
// extensions, so no other SQLite is needed.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import { sha256File, vec0Path } from '../vectors/extension'
import { VEC0_VERSION, type Vec0Asset, vec0AssetFor } from '../vectors/vec0-release'
import type { Health } from './daemon-client'
import type { InstallEnv } from './env'
import { writeFileAtomic } from './files'
import type { Action } from './plan'
import { hasBuiltLibrary } from './sqlite3mc-install'

export const VEC0_DOWNLOAD_TIMEOUT_MS = 60_000
/** The release tarball is about 50 KB; anything far larger is not it. */
export const MAX_VEC0_TARBALL_BYTES = 5_000_000

const TAR_BLOCK = 512

export interface Vec0Plan {
  actions: Action[]
  /** The daemon must restart to load sqlite-vec: it was just installed, or the running daemon started without it. */
  restartDaemon: boolean
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function hasPinnedDylib(path: string, asset: Vec0Asset): boolean {
  try {
    return existsSync(path) && sha256File(path) === asset.dylibSha256
  } catch {
    return false
  }
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
  const dylib = tarMember(Bun.gunzipSync(tarball), asset.member)
  if (dylib === null) throw new Error(`the sqlite-vec tarball has no ${asset.member}; nothing was written`)
  if (sha256(dylib) !== asset.dylibSha256) throw new Error(`${asset.member} does not match the pinned sha256; nothing was written`)
  mkdirSync(dirname(path), { recursive: true, mode: DATA_DIR_MODE })
  writeFileAtomic(path, dylib, DATA_FILE_MODE)
}

function hasSqlite3mc(env: InstallEnv): boolean {
  return hasBuiltLibrary(env.dataDir)
}

/** `sam status`: what the daemon reports, else what is missing. Read-only: a hash of the file, no load. */
export function vectorStatusLine(env: InstallEnv, health: Health): string {
  const asset = vec0AssetFor(env.platform, env.arch ?? process.arch)
  if (asset === null) return `semantic search: off (no pinned sqlite-vec build for ${env.platform}-${env.arch ?? process.arch})`
  const missing = [
    ...(hasSqlite3mc(env) ? [] : ['the sqlite3mc library (sam install)']),
    ...(hasPinnedDylib(vec0Path(env.dataDir), asset) ? [] : [`sqlite-vec ${VEC0_VERSION} (sam install)`]),
  ]
  if (health.up && health.vectorSearch === 'on') return 'semantic search: on'
  if (missing.length > 0) return `semantic search: off; missing ${missing.join(' and ')}`
  return health.up ? 'semantic search: off in the running daemon; restart it (sam install restarts it)' : 'semantic search: ready; the daemon is down'
}

/** The install step, plus notes on what search still needs. */
export function vec0InstallActions(env: InstallEnv, health: Health): Vec0Plan {
  const arch = env.arch ?? process.arch
  const asset = vec0AssetFor(env.platform, arch)
  if (asset === null) {
    env.out(`semantic search: no pinned sqlite-vec build for ${env.platform}-${arch}; search stays keyword-only`)
    return { actions: [], restartDaemon: false }
  }
  const path = vec0Path(env.dataDir)
  if (hasPinnedDylib(path, asset)) {
    env.out(`semantic search: sqlite-vec ${VEC0_VERSION} already at ${path}`)
    const stale = health.up && health.vectorSearch === 'off'
    if (stale) env.out('semantic search: the running daemon started without it, so it is restarted')
    return { actions: [], restartDaemon: stale }
  }
  return { actions: [{ kind: 'install-vec0', path, asset }], restartDaemon: true }
}
