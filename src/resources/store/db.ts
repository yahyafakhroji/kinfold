// Opens the one SQLite file the daemon owns. Pragma order
// matters: auto_vacuum only takes effect before the first table exists, so it
// goes first; secure_delete makes purges overwrite freed pages on disk.

import { closeSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { DbKeyStore } from '../sqlite/keys'
import { openStoreFile } from '../sqlite/open'
import type { Database } from '../sqlite/types'
import { DATA_FILE_MODE, DB_FILE, enforceFileMode, ensureDataDir } from './data-dir'
import { LATEST_SCHEMA_VERSION, MIGRATIONS, MIGRATION_STEPS } from './schema'

export interface Store {
  db: Database
  path: string
  schemaVersion: number
}

const SIDE_FILES = ['', '-wal', '-shm'] as const

function applyPragmas(db: Database): void {
  db.run('PRAGMA auto_vacuum = INCREMENTAL')
  db.run('PRAGMA journal_mode = WAL')
  db.run('PRAGMA foreign_keys = ON')
  db.run('PRAGMA secure_delete = ON')
  db.run('PRAGMA busy_timeout = 2000')
}

export function schemaVersionOf(db: Database): number {
  const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get()
  return row?.user_version ?? 0
}

/** Runs each pending migration (SQL, then its TypeScript step if any) in its own transaction, so a failure leaves the last good version. */
export function migrate(db: Database): number {
  const current = schemaVersionOf(db)
  if (current > LATEST_SCHEMA_VERSION) {
    throw new Error(`database schema ${current} is newer than this build (${LATEST_SCHEMA_VERSION})`)
  }
  MIGRATIONS.slice(current).forEach((sql, offset) => {
    const target = current + offset + 1
    db.transaction(() => {
      db.run(sql)
      MIGRATION_STEPS[target]?.(db)
      db.run(`PRAGMA user_version = ${target}`)
    })()
  })
  return schemaVersionOf(db)
}

/** WAL and SHM appear on first write, so modes are fixed after migrations run. */
export function enforceStoreModes(path: string): void {
  for (const suffix of SIDE_FILES) enforceFileMode(`${path}${suffix}`)
}

/** `keys` defaults to this platform's store (src/sqlite/keys.ts); tests pass their own. */
export function openStore(dataDir: string, options: { keys?: DbKeyStore } = {}): Store {
  const path = join(ensureDataDir(dataDir), DB_FILE)
  closeSync(openSync(path, 'a', DATA_FILE_MODE))
  enforceFileMode(path)

  const db = openStoreFile(path, { create: true, keys: options.keys })
  try {
    applyPragmas(db)
    const schemaVersion = migrate(db)
    enforceStoreModes(path)
    return { db, path, schemaVersion }
  } catch (error: unknown) {
    db.close()
    throw error
  }
}
