// Builds the pinned sqlite3mc into .cache/sqlite3mc/ for tests and
// development: `bun tools/build-sqlite3mc.ts [path/to/amalgamation.zip]`.
// Without a zip path it downloads the pinned release. Tests find the result
// through src/sqlite/test-support.ts.

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildSqlite3mc } from '../src/sqlite/build'
import { SQLITE3MC_ZIP_URL, sqlite3mcLibraryExtension } from '../src/sqlite/release'
import { TEST_LIBRARY_DIR } from '../src/sqlite/test-support'

const extension = sqlite3mcLibraryExtension(process.platform)
if (extension === null) throw new Error(`no local build for ${process.platform}`)
const zipPath = process.argv[2]
const zip = zipPath !== undefined ? new Uint8Array(readFileSync(zipPath)) : new Uint8Array(await (await fetch(SQLITE3MC_ZIP_URL, { signal: AbortSignal.timeout(60_000) })).arrayBuffer())
const output = join(TEST_LIBRARY_DIR, `libsqlite3mc.${extension}`)
mkdirSync(TEST_LIBRARY_DIR, { recursive: true, mode: 0o700 })
const workDir = join(TEST_LIBRARY_DIR, `build-${process.pid}`)
try {
  const hash = buildSqlite3mc({ zip, workDir, output })
  console.log(`built ${output} sha256=${hash}`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
