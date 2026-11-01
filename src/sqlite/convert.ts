// Converting memory.db in place (P2-E slice E3): plaintext to encrypted, back,
// or to a new key. The caller stops the daemon and writes the maintenance
// marker first; this file does the database part and checks its own work:
//   1. refuse unless the free space holds a full copy, twice over;
//   2. checkpoint and leave WAL mode, which fails while any other process
//      still has the file open, so nothing else can be mid-write;
//   3. copy the file to a backup (0600);
//   4. PRAGMA rekey, then back to WAL;
//   5. reopen the result as it should now be and compare every table's row
//      count with the one before, plus integrity_check and the FTS check;
//   6. on any failure put the backup back; on success delete it.
// Deleting the backup does not wipe its blocks on an SSD, and snapshots or
// backups may hold copies; `kinfold encrypt` says so.

import { chmodSync, copyFileSync, existsSync, renameSync, rmSync, statSync, statfsSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileState, maintenancePath, openEncrypted, openPlain } from './open'
import { type Database, SqliteError } from './types'

export class ConvertError extends Error {
  /** `restore` means the backup could not be put back: memory.db may be half converted, so no key may be removed. */
  constructor(readonly stage: 'check' | 'lock' | 'rekey' | 'verify' | 'restore', message: string) {
    super(message)
    this.name = 'ConvertError'
  }
}

export interface ConvertInput {
  path: string
  /** The current key; null for a plaintext store. */
  from: string | null
  /** The new key; null to store plaintext. */
  to: string | null
  log: (line: string) => void
  env?: Readonly<Record<string, string | undefined>>
  /** Test seam: the free bytes beside the store. */
  freeBytes?: (dir: string) => number
  /** Test seam: runs after the rekey, before the check, to simulate a failure there. */
  afterRekey?: (db: Database) => void
}

export interface ConvertResult {
  tables: number
  rows: number
  ms: number
}

const SIDE_FILES = ['-wal', '-shm', '-journal'] as const

function freeBytesOf(dir: string): number {
  const stats = statfsSync(dir)
  return Number(stats.bavail) * Number(stats.bsize)
}

/** The engine is the one opener the maintenance marker lets through: openPlain and openEncrypted do not check it. */
function open(input: ConvertInput, key: string | null): Database {
  const options = { create: false }
  return key === null ? openPlain(input.path, options, input.env) : openEncrypted(input.path, key, options, input.env)
}

/** Row counts per table, FTS shadow tables included: the comparison that proves nothing was lost. */
export function rowCounts(db: Database): Map<string, number> {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  return new Map(tables.map(({ name }) => [name, db.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${name.replace(/"/g, '""')}"`).get()!.n]))
}

export function backupPath(path: string): string {
  return `${path}.kinfold-convert-backup`
}

/** The backup the pre-rename version left; found by readers, never written. */
function legacyBackupPath(path: string): string {
  return `${path}.sam-convert-backup`
}

/** The backup on disk, in either name, else the path a new run would write. */
export function foundBackupPath(path: string): string {
  return [backupPath(path), legacyBackupPath(path)].find((candidate) => existsSync(candidate)) ?? backupPath(path)
}

/** Puts the backup back over memory.db. The rename is atomic, so at every moment one of the two names holds an intact copy. */
export function restoreBackup(path: string, backup: string = foundBackupPath(path)): void {
  for (const suffix of SIDE_FILES) rmSync(`${path}${suffix}`, { force: true })
  renameSync(backup, path)
}

/**
 * The table counts when `path` opens with `key` (null: plaintext) and passes
 * integrity_check and the FTS check; null when it does not open or fails a
 * check. Used to decide how an interrupted conversion ended.
 */
export function checkedCounts(path: string, key: string | null, env?: Readonly<Record<string, string | undefined>>): Map<string, number> | null {
  let db: Database | null = null
  try {
    db = key === null ? openPlain(path, { create: false }, env) : openEncrypted(path, key, { create: false }, env)
    if (db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()?.integrity_check !== 'ok') return null
    const counts = rowCounts(db)
    if (counts.has('observations_fts')) db.run("INSERT INTO observations_fts(observations_fts) VALUES ('integrity-check')")
    return counts
  } catch {
    return null
  } finally {
    db?.close()
  }
}

export function sameCounts(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  return a.size === b.size && [...a].every(([table, count]) => b.get(table) === count)
}

export function convertStore(input: ConvertInput): ConvertResult {
  const started = performance.now()
  const { path, log } = input
  const expected = input.from === null ? 'plain' : 'encrypted'
  if (!existsSync(maintenancePath(path))) throw new ConvertError('check', 'the maintenance marker is missing; convert only through kinfold encrypt, decrypt or rekey')
  if (fileState(path) !== expected) throw new ConvertError('check', `memory.db is not ${expected === 'plain' ? 'plaintext' : 'encrypted'}`)
  if (input.from === input.to) throw new ConvertError('check', 'the old and new keys are the same')
  const size = statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0)
  const free = (input.freeBytes ?? freeBytesOf)(dirname(path))
  if (free < size * 2) throw new ConvertError('check', `not enough free space: ${size * 2} bytes needed, ${free} free`)
  const backup = foundBackupPath(path)
  if (existsSync(backup)) throw new ConvertError('check', `${backup} exists from an earlier run; check it, then remove it`)

  const db = open(input, input.from)
  let before: Map<string, number>
  let version: number
  try {
    const checkpoint = db.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()
    if (checkpoint !== null && checkpoint.busy !== 0) throw new ConvertError('lock', 'another process is using memory.db; stop it and try again')
    const mode = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode = DELETE').get()
    if (mode?.journal_mode !== 'delete') throw new ConvertError('lock', 'another process is using memory.db; stop it and try again')
    before = rowCounts(db)
    version = db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version
  } catch (error: unknown) {
    db.close()
    if (error instanceof ConvertError) throw error
    // SQLite may refuse with BUSY or LOCKED instead of staying in WAL mode; either way someone else holds the file.
    if (error instanceof SqliteError && /^SQLITE_(BUSY|LOCKED)/.test(error.code)) throw new ConvertError('lock', 'another process is using memory.db; stop it and try again')
    throw new ConvertError('lock', `could not take memory.db (${error instanceof Error ? error.name : 'error'})`)
  }

  try {
    copyFileSync(path, backup)
    chmodSync(backup, 0o600)
  } catch (error: unknown) {
    db.close()
    rmSync(backup, { force: true })
    throw new ConvertError('check', `the backup could not be written (${error instanceof Error ? error.name : 'error'}); memory.db is as it was`)
  }
  log(`convert: backup written (${size} bytes)`)
  let converted: Database | null = null
  let closed = false
  try {
    // Anyone who slipped past the marker and wrote since the backup would be lost by a later restore: stop here instead.
    if (db.query<{ data_version: number }, []>('PRAGMA data_version').get()!.data_version !== version) {
      throw new ConvertError('lock', 'another process wrote to memory.db during the backup; stop it and try again')
    }
    db.exec(input.to === null ? "PRAGMA rekey = ''" : `PRAGMA rekey = 'raw:${input.to}'`)
    db.exec('PRAGMA journal_mode = WAL')
    input.afterRekey?.(db)
    db.close()
    closed = true
    if (fileState(path) !== (input.to === null ? 'plain' : 'encrypted')) throw new ConvertError('verify', 'the file did not change as asked')
    converted = open(input, input.to)
    const integrity = converted.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get()
    if (integrity?.integrity_check !== 'ok') throw new ConvertError('verify', 'integrity_check failed after the conversion')
    if (before.has('observations_fts')) converted.run("INSERT INTO observations_fts(observations_fts) VALUES ('integrity-check')")
    const after = rowCounts(converted)
    for (const [table, count] of before) {
      if (after.get(table) !== count) throw new ConvertError('verify', `row count changed in ${table}`)
    }
    converted.close()
    converted = null
  } catch (error: unknown) {
    converted?.close()
    if (!closed) db.close()
    try {
      restoreBackup(path, backup)
    } catch {
      throw new ConvertError('restore', `the conversion failed and the backup could not be put back; the original is ${backup}; run kinfold key resume`)
    }
    log('convert: failed; the backup was put back')
    throw error instanceof ConvertError ? error : new ConvertError('rekey', `the conversion failed (${error instanceof Error ? error.name : 'error'}); memory.db is as it was`)
  }
  rmSync(backup, { force: true })
  log('convert: checked; backup removed')
  const rows = [...before.values()].reduce((sum, n) => sum + n, 0)
  return { tables: before.size, rows, ms: Math.round(performance.now() - started) }
}
