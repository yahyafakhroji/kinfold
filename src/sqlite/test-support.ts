// Tests open databases through the same sqlite3mc build the daemon uses.
// `bun tools/build-sqlite3mc.ts` puts it in .cache/sqlite3mc/.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readEnv } from '../env-names'
import { openWithLibrary } from './driver'
import { SQLITE3MC_LIB_ENV } from './library'
import { sqlite3mcLibraryExtension } from './release'
import type { Database } from './types'

export const TEST_LIBRARY_DIR = join(import.meta.dir, '..', '..', '.cache', 'sqlite3mc')

export function testLibraryPath(): string {
  const override = readEnv(process.env, 'SQLITE3MC_LIB')
  if (override !== undefined && override !== '') return override
  const path = join(TEST_LIBRARY_DIR, `libsqlite3mc.${sqlite3mcLibraryExtension(process.platform) ?? 'missing'}`)
  if (!existsSync(path)) throw new Error(`no sqlite3mc build at ${path}; run: bun tools/build-sqlite3mc.ts`)
  return path
}

export function openTestDatabase(path: string, options: { readonly?: boolean } = {}): Database {
  return openWithLibrary(testLibraryPath(), path, options)
}
