// Proves that a compiled Kinfold program can load sqlite3mc through bun:ffi and
// use it with a key on every platform. The library path is an argument because
// the check runs before an install has created a data dir to find one in.
// Usage: driver-check <path to the sqlite3mc library>

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openEncrypted } from '../src/sqlite/open'
import { SqliteError } from '../src/sqlite/types'

const TEST_KEY = '0123456789abcdef'.repeat(4)
const WRONG_KEY = 'fedcba9876543210'.repeat(4)

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const library = process.argv[2]
if (library === undefined) {
  console.error('usage: driver-check <path to the sqlite3mc library>')
  process.exit(1)
}

const env = { ...process.env, KINFOLD_SQLITE3MC_LIB: resolve(library) }
let workDir: string | null = null

try {
  workDir = mkdtempSync(join(tmpdir(), 'kinfold-driver-check-'))
  const dbPath = join(workDir, 'memory.db')

  const created = openEncrypted(dbPath, TEST_KEY, {}, env)
  created.exec('CREATE TABLE driver_check (value TEXT NOT NULL)')
  created.run('INSERT INTO driver_check (value) VALUES (?)', 'kinfold')
  created.close()

  const reopened = openEncrypted(dbPath, TEST_KEY, {}, env)
  const row = reopened.query<{ value: string }>('SELECT value FROM driver_check').get()
  reopened.close()
  if (row?.value !== 'kinfold') throw new Error('the stored row did not come back')

  let refused = false
  let wrong: ReturnType<typeof openEncrypted> | null = null
  try {
    wrong = openEncrypted(dbPath, WRONG_KEY, {}, env)
  } catch (error: unknown) {
    if (!(error instanceof SqliteError) || error.kind !== 'bad_key') throw new Error(`the wrong key failed as ${error instanceof SqliteError ? error.kind : describe(error)}`)
    refused = true
  } finally {
    wrong?.close()
  }
  if (!refused) throw new Error('the database opened with the wrong key')

  console.log('driver-check ok')
} catch (error: unknown) {
  console.error(`driver-check failed: ${describe(error)}`)
  process.exitCode = 1
} finally {
  if (workDir !== null) rmSync(workDir, { recursive: true, force: true })
}
