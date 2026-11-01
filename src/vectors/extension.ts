// Loading sqlite-vec into the daemon (P2-A). Every process opens the store
// through sqlite3mc (src/sqlite/, P2-E), which allows extension loading, so
// the Homebrew SQLite swap P2-A needed on macOS is gone. vec0.dylib from the
// data dir is hashed against the pinned release and loaded into the daemon's
// connection only. Every failure is a reason string, never a throw: search
// falls back to FTS without it.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from '../sqlite/types'
import { vec0AssetFor } from './vec0-release'

export const VEC0_DIR = 'lib'
export const VEC0_FILE = 'vec0.dylib'

export type Support = { ok: true; detail: string } | { ok: false; reason: string }

export function vec0Path(dataDir: string): string {
  return join(dataDir, VEC0_DIR, VEC0_FILE)
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Hash check, load, then vec_version() as the proof that the functions answer. */
export function loadVec0(db: Database, dataDir: string, platform: string = process.platform, arch: string = process.arch): Support {
  const asset = vec0AssetFor(platform, arch)
  if (asset === null) return { ok: false, reason: `no pinned sqlite-vec build for ${platform}-${arch}` }
  const path = vec0Path(dataDir)
  if (!existsSync(path)) return { ok: false, reason: `${path} is missing; run kinfold install` }
  try {
    if (sha256File(path) !== asset.dylibSha256) return { ok: false, reason: `${path} does not match the pinned sqlite-vec build; run kinfold install` }
    db.loadExtension(path)
    const row = db.query<{ v: string }, []>('SELECT vec_version() AS v').get()
    return { ok: true, detail: `sqlite-vec ${row?.v ?? 'unknown'}` }
  } catch (error: unknown) {
    return { ok: false, reason: `sqlite-vec did not load (${error instanceof Error ? error.message.slice(0, 120) : 'error'})` }
  }
}
