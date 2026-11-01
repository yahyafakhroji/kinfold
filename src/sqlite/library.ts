// Where the sqlite3mc library lives (P2-E): <dataDir>/lib, next to vec0. Each
// build is a file named by its own hash, and lib/sqlite3mc.json names the
// current one with its sha256 and the source zip's. The installer writes the
// library first and replaces the manifest atomically, so a reader sees the old
// build or the new one, never a library with a hash that does not match. The
// hash check catches a truncated or swapped file; it is no defence against
// someone who can write the data dir, since that person can write the
// manifest too. KINFOLD_SQLITE3MC_LIB points tests and development at another
// build, unchecked.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { envName, readEnv } from '../env-names'
import { sqlite3mcLibraryExtension } from './release'
import { SqliteError } from './types'

export const SQLITE3MC_LIB_ENV = envName('SQLITE3MC_LIB')
export const LIB_DIR = 'lib'
export const MANIFEST_FILE = 'sqlite3mc.json'

export interface LibraryManifest {
  /** A file name in lib/, never a path. */
  file: string
  sha256: string
  /** The amalgamation zip it was built from; a different pin means a rebuild. */
  sourceSha256: string
}

const HEX64 = /^[0-9a-f]{64}$/
const FILE_NAME = /^libsqlite3mc-[0-9a-f]{16}\.(dylib|so|dll)$/

export function libDir(dataDir: string): string {
  return join(dataDir, LIB_DIR)
}

export function manifestPath(dataDir: string): string {
  return join(libDir(dataDir), MANIFEST_FILE)
}

/** The file name for a build with this hash on this platform, or null where P2-E has no build. */
export function libraryFileName(sha256: string, platform: string = process.platform): string | null {
  const extension = sqlite3mcLibraryExtension(platform)
  return extension === null ? null : `libsqlite3mc-${sha256.slice(0, 16)}.${extension}`
}

/** The manifest when it parses and names a plausible file; null otherwise. */
export function readManifest(dataDir: string): LibraryManifest | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(manifestPath(dataDir), 'utf8'))
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const { file, sha256, sourceSha256 } = value as Record<string, unknown>
  if (typeof file !== 'string' || !FILE_NAME.test(file)) return null
  if (typeof sha256 !== 'string' || !HEX64.test(sha256) || typeof sourceSha256 !== 'string' || !HEX64.test(sourceSha256)) return null
  return { file, sha256, sourceSha256 }
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The library the manifest names, when it exists and matches its hash; else a reason. */
export function checkLibrary(dataDir: string): { ok: true; path: string; manifest: LibraryManifest } | { ok: false; reason: string } {
  const manifest = readManifest(dataDir)
  if (manifest === null) return { ok: false, reason: 'sqlite3mc library is not installed; run kinfold install' }
  const path = join(libDir(dataDir), manifest.file)
  if (!existsSync(path)) return { ok: false, reason: 'sqlite3mc library named by the manifest is missing; run kinfold install' }
  if (sha256File(path) !== manifest.sha256) return { ok: false, reason: 'sqlite3mc library does not match its recorded hash; run kinfold install' }
  return { ok: true, path, manifest }
}

const checked = new Map<string, string>()

/** The library for a DB file inside a data dir: the env override, or the manifest's build, checked once per process. */
export function libraryFor(dbPath: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const override = readEnv(env, 'SQLITE3MC_LIB')
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) throw new SqliteError(`${SQLITE3MC_LIB_ENV} names a missing file`, 'SQLITE_CANTOPEN', 14, 'library')
    return override
  }
  const dataDir = dirname(dbPath)
  const known = checked.get(dataDir)
  if (known !== undefined) return known
  const result = checkLibrary(dataDir)
  if (!result.ok) throw new SqliteError(result.reason, 'SQLITE_CANTOPEN', 14, 'library')
  checked.set(dataDir, result.path)
  return result.path
}
