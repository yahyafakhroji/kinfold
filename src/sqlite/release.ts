// The pinned SQLite3 Multiple Ciphers source. The user chose local
// builds for now: `kinfold install` compiles this amalgamation on the machine, so
// the pin covers the source, and the built library's own hash is recorded
// next to it.

export const SQLITE3MC_VERSION = '2.6.1'
export const SQLITE3MC_SQLITE_VERSION = '3.54.0'
export const SQLITE3MC_ZIP_NAME = `sqlite3mc-${SQLITE3MC_VERSION}-sqlite-${SQLITE3MC_SQLITE_VERSION}-amalgamation.zip`
export const SQLITE3MC_ZIP_URL = `https://github.com/utelle/SQLite3MultipleCiphers/releases/download/v${SQLITE3MC_VERSION}/${SQLITE3MC_ZIP_NAME}`
/** The API URL for the same asset; build tools fall back to it when the release URL answers a server error. */
export const SQLITE3MC_ZIP_API_URL = 'https://api.github.com/repos/utelle/SQLite3MultipleCiphers/releases/assets/633720268'
/** Matches the GitHub asset digest and the release's SHA256SUMS (checked 2026-10-31). */
export const SQLITE3MC_ZIP_SHA256 = '3f25af603566a23c821d8e581778b5ece2a541d2435776de57b8d845c176815a'
/** The zip is about 3.9 MB; anything far larger is not it. */
export const MAX_SQLITE3MC_ZIP_BYTES = 20_000_000

/** The members a build needs; nothing else in the zip is ever written out. */
export const AMALGAMATION_MEMBERS = ['sqlite3mc_amalgamation.c', 'sqlite3mc_amalgamation.h', 'sqlite3.h', 'sqlite3ext.h'] as const

/** FTS5 must be asked for: the amalgamation leaves it off. Extension loading is on by default. */
export const SQLITE3MC_DEFINES = [
  '-DSQLITE_ENABLE_FTS5',
  /** The size report reads bytes per table from dbstat. */
  '-DSQLITE_ENABLE_DBSTAT_VTAB',
  '-DSQLITE_THREADSAFE=1',
  '-DSQLITE_DQS=0',
  '-DSQLITE_DEFAULT_WAL_SYNCHRONOUS=1',
  '-DSQLITE_USE_URI=1',
] as const

/** The shared-library extension on this platform, or null where there is no build yet. */
export function sqlite3mcLibraryExtension(platform: string): string | null {
  if (platform === 'darwin') return 'dylib'
  if (platform === 'linux') return 'so'
  if (platform === 'win32') return 'dll'
  return null
}
