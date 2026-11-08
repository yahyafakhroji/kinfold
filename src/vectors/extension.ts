// Loading sqlite-vec into the daemon. Every process opens the store
// through sqlite3mc (src/sqlite/), which allows extension loading, so
// the Homebrew SQLite swap vector search once needed on macOS is gone. The
// pinned vec0 member from the data dir is hashed against the release and
// loaded into the daemon's connection only. Every failure is a reason string,
// never a throw: search falls back to FTS without it.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from '../sqlite/types'
import { vec0AssetFor } from './vec0-release'

export const VEC0_DIR = 'lib'

const VEC0_FILES: Readonly<Record<string, string>> = { darwin: 'vec0.dylib', linux: 'vec0.so', win32: 'vec0.dll' }

export type Support = { ok: true; detail: string } | { ok: false; reason: string }

/** The vec0 file name on a platform, or null where Kinfold has no build. */
export function vec0FileName(platform: string): string | null {
  return VEC0_FILES[platform] ?? null
}

export function vec0Path(dataDir: string, platform: string = process.platform): string {
  return join(dataDir, VEC0_DIR, vec0FileName(platform) ?? 'vec0.dylib')
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Hash check, load, then vec_version() as the proof that the functions answer. */
export function loadVec0(db: Database, dataDir: string, platform: string = process.platform, arch: string = process.arch): Support {
  const asset = vec0AssetFor(platform, arch)
  if (asset === null) return { ok: false, reason: `no pinned sqlite-vec build for ${platform}-${arch}` }
  const path = vec0Path(dataDir, platform)
  if (!existsSync(path)) return { ok: false, reason: `${path} is missing; run kinfold install` }
  try {
    if (sha256File(path) !== asset.fileSha256) return { ok: false, reason: `${path} does not match the pinned sqlite-vec build; run kinfold install` }
    db.loadExtension(path)
    const row = db.query<{ v: string }, []>('SELECT vec_version() AS v').get()
    return { ok: true, detail: `sqlite-vec ${row?.v ?? 'unknown'}` }
  } catch (error: unknown) {
    return { ok: false, reason: `sqlite-vec did not load (${error instanceof Error ? error.message.slice(0, 120) : 'error'})` }
  }
}
