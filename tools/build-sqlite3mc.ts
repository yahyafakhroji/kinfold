// Builds the pinned sqlite3mc into .cache/sqlite3mc/ for tests and
// development: `bun tools/build-sqlite3mc.ts [path/to/amalgamation.zip]`.
// Without a zip path it downloads the pinned release. Tests find the result
// through src/sqlite/test-support.ts.

import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildSqlite3mc } from '../src/sqlite/build'
import { MAX_SQLITE3MC_ZIP_BYTES, SQLITE3MC_ZIP_API_URL, SQLITE3MC_ZIP_SHA256, SQLITE3MC_ZIP_URL, sqlite3mcLibraryExtension } from '../src/sqlite/release'
import { TEST_LIBRARY_DIR } from '../src/sqlite/test-support'
import { downloadPinned } from './pinned-download'

const extension = sqlite3mcLibraryExtension(process.platform)
if (extension === null) throw new Error(`no local build for ${process.platform}`)
const zipPath = process.argv[2]
const zip = zipPath !== undefined
  ? new Uint8Array(readFileSync(zipPath))
  : await downloadPinned({ label: 'sqlite3mc', releaseUrl: SQLITE3MC_ZIP_URL, apiUrl: SQLITE3MC_ZIP_API_URL, sha256: SQLITE3MC_ZIP_SHA256, maxBytes: MAX_SQLITE3MC_ZIP_BYTES, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN })
const output = join(TEST_LIBRARY_DIR, `libsqlite3mc.${extension}`)
mkdirSync(TEST_LIBRARY_DIR, { recursive: true, mode: 0o700 })
const workDir = join(TEST_LIBRARY_DIR, `build-${process.pid}`)
try {
  const hash = buildSqlite3mc({ zip, workDir, output })
  console.log(`built ${output} sha256=${hash}`)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
