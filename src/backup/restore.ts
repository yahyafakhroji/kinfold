// Restoring a backup over the store in this data folder. The order is what
// keeps a failure harmless:
//
//   stage   the snapshot is copied out of the archive into restore-staging/,
//           opened with the key the recovery code gave, checked against this
//           build's schema and migrated there. Nothing else has changed yet,
//           so a wrong code, a damaged file or a newer schema ends here.
//   journal the maintenance marker is written: hooks and MCP servers stay
//           off memory.db, and `kinfold key resume` can read how far a
//           killed run got.
//   keys    the new key goes to db-key-next, and the key of a store that is
//           kept goes to db-key-replaced, each read back, before any file
//           moves: no store is ever on disk without a key that opens it.
//   swap    the old store is renamed aside, the staged one renamed into
//           place (two atomic renames), then db-key takes the new key.
//   finish  the old store is deleted when it held no memory, or kept as
//           memory.db.kinfold-replaced when it did.
//
// Up to the second rename the run can be undone and db-key still opens the
// old store; from then on it can only be finished. settle() decides which
// from what is on disk, for a failure inside the run and for resume alike.

import { existsSync, mkdirSync, renameSync, rmSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fs/atomic'
import { installRecordAction, readInstallRecord } from '../install/setup/record'
import { DB_KEY_NEXT_REF, DB_KEY_REF, DB_KEY_REPLACED_REF } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import { foundBackupPath } from '../sqlite/convert'
import { fileState, maintenancePath, openEncrypted, openPlain } from '../sqlite/open'
import { type Database, SqliteError } from '../sqlite/types'
import { DATA_DIR_MODE, DB_FILE } from '../store/data-dir'
import { openStore } from '../store/db'
import { LATEST_SCHEMA_VERSION } from '../store/schema'
import { type ArchiveHeader, type BackupManifest, BackupError, extractSnapshot, readArchive } from './archive'
import { type PreviousStore, type RestoreJournal, readRestoreJournal, writeRestoreJournal } from './journal'

export const RESTORE_STAGING_DIR = 'restore-staging'
/** Agent sessions let go of an idle reader within 30 s and cannot reopen past the marker; a few seconds more and the file is free. */
export const LOCK_ATTEMPTS = 36
export const LOCK_RETRY_MS = 1_000

/** Rows in any of these mean the store holds memory worth keeping. */
const MEMORY_TABLES = ['sessions', 'events', 'prompts', 'observations', 'summaries'] as const
const SIDE_FILES = ['-wal', '-shm', '-journal'] as const

export const FAULT_POINTS = ['after-journal', 'after-keys', 'after-move-aside', 'after-move-in', 'after-key-swap'] as const
export type FaultPoint = (typeof FAULT_POINTS)[number]
export type RestoreStep = 'close' | 'swap'

/** Test seam: stands for the process being killed at a point, so nothing after it runs, the undo included. */
export class RestoreCrash extends Error {
  constructor(readonly point: FaultPoint) {
    super(`restore stopped ${point}`)
    this.name = 'RestoreCrash'
  }
}

/** The restore failed and could neither be undone nor finished; the marker stays for `kinfold key resume`. */
export class RestoreStranded extends BackupError {
  constructor(message: string) {
    super('state', message)
    this.name = 'RestoreStranded'
  }
}

export function stagingDir(dataDir: string): string {
  return join(dataDir, RESTORE_STAGING_DIR)
}

/** Where a store that held memory is kept after a restore replaced it. */
export function replacedPath(dbPath: string): string {
  return `${dbPath}.kinfold-replaced`
}

/** The old store between the two renames; gone again once the restore is finished or undone. */
export function asidePath(dbPath: string): string {
  return `${dbPath}.kinfold-restore-aside`
}

export interface Staged {
  /** The staged store: migrated, one file, ready to rename into place. */
  path: string
  /** Its key; null for a plaintext snapshot. */
  key: string | null
  manifest: BackupManifest
  /** The schema the snapshot held before it was migrated here. */
  schemaVersion: number
}

export interface StageInput {
  dataDir: string
  archivePath: string
  header: ArchiveHeader
  /** The key the recovery code decoded to; null when none was given. */
  key: string | null
}

export interface RestoreInput {
  dataDir: string
  staged: Staged
  /** null: this platform has no key store, so only a plaintext backup can be restored. */
  keyStore: KeyStore | null
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  onStep?: (step: RestoreStep) => void
  lockAttempts?: number
  faultAt?: FaultPoint
}

export interface RestoreOutcome {
  /** What to tell the person, in order. Never holds a key. */
  lines: string[]
}

function newerSchema(version: number): BackupError {
  return new BackupError('schema', `this backup is from a newer Kinfold: its database is schema ${version}, and this Kinfold reads up to schema ${LATEST_SCHEMA_VERSION}. Update Kinfold, then restore. Nothing was changed`)
}

const damaged = (): BackupError => new BackupError('tampered', 'the backup file is damaged: its snapshot does not open. Nothing was changed')

/** Reads the archive's manifest and refuses a backup this build cannot read. Changes nothing. */
export function inspectBackup(archivePath: string): ArchiveHeader {
  const header = readArchive(archivePath)
  if (header.manifest.schemaVersion > LATEST_SCHEMA_VERSION) throw newerSchema(header.manifest.schemaVersion)
  return header
}

function openAt(path: string, key: string | null): Database {
  return key === null ? openPlain(path, { create: false }) : openEncrypted(path, key, { create: false })
}

function opens(path: string, key: string | null): boolean {
  try {
    const db = openAt(path, key)
    try {
      db.query('SELECT count(*) FROM sqlite_master').get()
    } finally {
      db.close()
    }
    return true
  } catch {
    return false
  }
}

function fixedKeys(key: string | null): { name: string; read: () => string | null; exists: () => boolean } {
  return { name: 'restore', read: () => key, exists: () => key !== null }
}

/** Runs this build's migrations on the staged copy and leaves it as one file in rollback-journal mode, so a rename moves all of it. */
function migrateStaged(dir: string, key: string | null): void {
  const store = openStore(dir, { keys: fixedKeys(key) })
  try {
    store.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get()
    store.db.query('PRAGMA journal_mode = DELETE').get()
  } finally {
    store.db.close()
  }
}

/**
 * Copies the snapshot out, proves the key opens it, and migrates the copy.
 * The store, the key store and the marker are untouched: every refusal here
 * (wrong code, damaged file, newer schema, no room) leaves things as they
 * were, with the staging folder removed.
 */
export async function stageSnapshot(input: StageInput): Promise<Staged> {
  const dbPath = join(input.dataDir, DB_FILE)
  if (existsSync(maintenancePath(dbPath))) throw new BackupError('busy', 'a kinfold encrypt, decrypt, rekey or restore is running or was cut short; if none is running, run kinfold key resume')
  mkdirSync(input.dataDir, { recursive: true, mode: DATA_DIR_MODE })
  const { bytes } = input.header.manifest.snapshot
  const stats = statfsSync(input.dataDir)
  const free = Number(stats.bavail) * Number(stats.bsize)
  // The staged copy, and as much again for the migration's journal.
  if (free < bytes * 2) throw new BackupError('space', `not enough free space to restore: ${bytes * 2} bytes needed, ${free} free. Nothing was changed`)
  const dir = stagingDir(input.dataDir)
  const path = join(dir, DB_FILE)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { mode: DATA_DIR_MODE })
  try {
    await extractSnapshot(input.archivePath, input.header, path)
    const encrypted = fileState(path) === 'encrypted'
    if (encrypted && input.key === null) throw new BackupError('code', 'this backup is encrypted: restoring it needs its recovery code. Nothing was changed')
    const key = encrypted ? input.key : null
    let db: Database
    try {
      db = openAt(path, key)
    } catch {
      throw encrypted ? new BackupError('code', 'that recovery code does not open this backup. Nothing was changed') : damaged()
    }
    let schemaVersion: number
    try {
      schemaVersion = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0
    } catch {
      throw damaged()
    } finally {
      db.close()
    }
    // The manifest is advice; the snapshot's own version is what migrations would meet.
    if (schemaVersion > LATEST_SCHEMA_VERSION) throw newerSchema(schemaVersion)
    try {
      migrateStaged(dir, key)
    } catch (error: unknown) {
      throw new BackupError('state', `the backup could not be brought to this Kinfold's schema (${error instanceof Error ? error.name : 'error'}). Nothing was changed`)
    }
    return { path, key, manifest: input.header.manifest, schemaVersion }
  } catch (error: unknown) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

/** Removes a staged snapshot that will not be used. Only for a run that has not written the marker. */
export function discardStaged(dataDir: string): void {
  rmSync(stagingDir(dataDir), { recursive: true, force: true })
}

interface Plan {
  dbPath: string
  previous: PreviousStore
  /** The key that opens the store that is here; null when it is plaintext or absent. */
  oldKey: string | null
  keepPrevious: boolean
}

function hasMemory(dbPath: string, key: string | null): boolean {
  // Read-write, so closing removes the WAL files a read would otherwise leave behind.
  const db = openAt(dbPath, key)
  try {
    return MEMORY_TABLES.some((table) => {
      try {
        return db.query(`SELECT 1 AS one FROM ${table} LIMIT 1`).get() !== null
      } catch {
        // A store from before this table existed has no rows in it.
        return false
      }
    })
  } finally {
    db.close()
  }
}

/** Everything that can refuse a restore before it starts. Changes nothing. */
export function checkRestore(input: Pick<RestoreInput, 'dataDir' | 'staged' | 'keyStore'>): Plan {
  const dbPath = join(input.dataDir, DB_FILE)
  const cutShort = 'if none is running, run kinfold key resume'
  if (existsSync(maintenancePath(dbPath))) throw new BackupError('busy', `a kinfold encrypt, decrypt, rekey or restore is running or was cut short; ${cutShort}`)
  if (existsSync(foundBackupPath(dbPath))) throw new BackupError('state', `${foundBackupPath(dbPath)} is left from a conversion that was cut short; run kinfold key resume first`)
  if (existsSync(asidePath(dbPath))) throw new BackupError('state', `${asidePath(dbPath)} is left from a restore that was cut short; it is the store that was here. Move it away, then restore again`)
  if (input.staged.key !== null && input.keyStore === null) throw new BackupError('key-store', 'this backup is encrypted, and there is no key store here to keep its key in. Nothing was changed')
  const state = fileState(dbPath)
  const previous: PreviousStore = state === 'new' ? 'none' : state
  const oldKey = previous === 'encrypted' ? (input.keyStore?.get(DB_KEY_REF) ?? null) : null
  const unopened = new BackupError('key-store', `memory.db here is encrypted and ${input.keyStore?.place ?? 'the key store'} has no key that opens it. Run kinfold key recover first, or move memory.db away. Nothing was changed`)
  if (previous === 'encrypted' && oldKey === null) throw unopened
  let keepPrevious = false
  if (previous !== 'none') {
    try {
      keepPrevious = hasMemory(dbPath, oldKey)
    } catch {
      throw unopened
    }
  }
  if (keepPrevious && existsSync(replacedPath(dbPath))) {
    throw new BackupError('state', `${replacedPath(dbPath)} is a store an earlier restore kept. Move it away or delete it, then restore again. Nothing was changed`)
  }
  return { dbPath, previous, oldKey, keepPrevious }
}

/** Writes the key and reads it back, so a store that silently drops a write stops the run before any file moves. */
function storeKey(store: KeyStore, ref: string, key: string): void {
  store.set(ref, key)
  if (store.get(ref) !== key) throw new BackupError('key-store', `${store.place} entry ${ref} did not read back`)
}

class Locked extends Error {}

/**
 * Checkpoints the old store and takes it out of WAL mode, which works only
 * when no other connection has it open: afterwards it is one file that no one
 * is reading, so the rename moves a whole store. Retries while a reader that
 * opened before the marker still holds it.
 */
async function takeExclusive(plan: Plan, input: RestoreInput): Promise<void> {
  const attempts = input.lockAttempts ?? LOCK_ATTEMPTS
  for (let attempt = 1; ; attempt += 1) {
    try {
      const db = openAt(plan.dbPath, plan.oldKey)
      try {
        const checkpoint = db.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get()
        if (checkpoint !== null && checkpoint.busy !== 0) throw new Locked()
        if (db.query<{ journal_mode: string }, []>('PRAGMA journal_mode = DELETE').get()?.journal_mode !== 'delete') throw new Locked()
      } finally {
        db.close()
      }
      return
    } catch (error: unknown) {
      const locked = error instanceof Locked || (error instanceof SqliteError && /^SQLITE_(BUSY|LOCKED)/.test(error.code))
      if (!locked) throw new BackupError('state', `the store that is here could not be closed (${error instanceof Error ? error.name : 'error'})`)
      if (attempt >= attempts) throw new BackupError('busy', 'another process is using memory.db (an agent session keeps it open through its MCP server). Close those sessions, then restore again. Nothing was changed')
      if (attempt === 1) input.log(`waiting up to ${Math.round((attempts * LOCK_RETRY_MS) / 1000)} s for agent sessions to let go of memory.db`)
      await input.sleep(LOCK_RETRY_MS)
    }
  }
}

function removeStore(path: string): void {
  for (const suffix of ['', ...SIDE_FILES]) rmSync(`${path}${suffix}`, { force: true })
}

function applySettings(dataDir: string, settings: BackupManifest['settings'], log: (line: string) => void): void {
  try {
    const record = readInstallRecord(dataDir)
    if (record === null || settings.updateCheck === undefined || record.updateCheck === settings.updateCheck) return
    const action = installRecordAction(dataDir, { ...record, updateCheck: settings.updateCheck })
    if (action.kind === 'write') writeFileAtomic(action.path, action.content, action.mode)
  } catch (error: unknown) {
    // The memory is restored either way; the choice can be set again with kinfold install.
    log(`warning: the backup's update-check choice was not applied (${error instanceof Error ? error.name : 'error'})`)
  }
}

interface Paths {
  dbPath: string
  staged: string
  aside: string
  replaced: string
  marker: string
}

function pathsOf(dataDir: string): Paths {
  const dbPath = join(dataDir, DB_FILE)
  return { dbPath, staged: join(stagingDir(dataDir), DB_FILE), aside: asidePath(dbPath), replaced: replacedPath(dbPath), marker: maintenancePath(dbPath) }
}

/** Past the second rename: give db-key the new key, settle the old store, clear the marker. Every step can run again. */
function finish(dataDir: string, keyStore: KeyStore | null, journal: RestoreJournal, log: (line: string) => void, afterKeys?: () => void): void {
  const paths = pathsOf(dataDir)
  if (journal.encrypted) {
    const next = keyStore?.get(DB_KEY_NEXT_REF) ?? null
    if (keyStore !== null && next !== null) {
      storeKey(keyStore, DB_KEY_REF, next)
      keyStore.delete(DB_KEY_NEXT_REF)
    }
  } else if (keyStore !== null && keyStore.exists(DB_KEY_REF)) {
    // A plaintext store beside a database key reads as a conversion that failed.
    keyStore.delete(DB_KEY_REF)
  }
  afterKeys?.()
  if (existsSync(paths.aside)) {
    if (journal.keepPrevious) renameSync(paths.aside, paths.replaced)
    else removeStore(paths.aside)
  }
  rmSync(stagingDir(dataDir), { recursive: true, force: true })
  applySettings(dataDir, journal.settings, log)
  rmSync(paths.marker, { force: true })
}

/** Before the second rename: put the old store back under its name and drop the keys the run added. */
function undo(dataDir: string, keyStore: KeyStore | null, journal: RestoreJournal): void {
  const paths = pathsOf(dataDir)
  const movedAside = existsSync(paths.aside)
  if (journal.previous !== 'none') {
    // db-key is untouched until the staged store is in place, so it still opens the old one.
    const oldKey = journal.previous === 'encrypted' ? (keyStore?.get(DB_KEY_REF) ?? null) : null
    const original = movedAside ? paths.aside : paths.dbPath
    if ((journal.previous === 'encrypted' && oldKey === null) || !opens(original, oldKey)) {
      throw new BackupError('state', 'the store that was here opens with neither key; nothing was deleted. Run kinfold key recover with your recovery code')
    }
  }
  if (movedAside) {
    removeStore(paths.dbPath)
    renameSync(paths.aside, paths.dbPath)
  }
  if (keyStore !== null) {
    if (keyStore.exists(DB_KEY_NEXT_REF)) keyStore.delete(DB_KEY_NEXT_REF)
    // Only the copy this run made: an entry beside a kept store belongs to that store.
    if (journal.keepPrevious && !existsSync(paths.replaced) && keyStore.exists(DB_KEY_REPLACED_REF)) keyStore.delete(DB_KEY_REPLACED_REF)
  }
  rmSync(stagingDir(dataDir), { recursive: true, force: true })
  rmSync(paths.marker, { force: true })
}

/**
 * Finishes the run when the staged store is already in place (it left the
 * staging folder and memory.db opens as the restored store should), and
 * undoes it otherwise.
 */
function settle(dataDir: string, keyStore: KeyStore | null, journal: RestoreJournal, log: (line: string) => void): 'finished' | 'undone' {
  const paths = pathsOf(dataDir)
  const targetKey = journal.encrypted ? (keyStore?.get(DB_KEY_NEXT_REF) ?? keyStore?.get(DB_KEY_REF) ?? null) : null
  const movedIn = !existsSync(paths.staged)
    && fileState(paths.dbPath) === (journal.encrypted ? 'encrypted' : 'plain')
    && (!journal.encrypted || targetKey !== null)
    && opens(paths.dbPath, targetKey)
  if (movedIn) {
    finish(dataDir, keyStore, journal, log)
    return 'finished'
  }
  undo(dataDir, keyStore, journal)
  return 'undone'
}

function outcomeLines(input: RestoreInput, plan: Plan): string[] {
  const { manifest, schemaVersion, key } = input.staged
  const lines = [`restored the backup made ${new Date(manifest.createdAt).toISOString()} by Kinfold ${manifest.kinfoldVersion}`]
  if (schemaVersion < LATEST_SCHEMA_VERSION) lines.push(`its database was schema ${schemaVersion}; it is schema ${LATEST_SCHEMA_VERSION} now`)
  if (key === null) lines.push('warning: this backup is not encrypted, so memory.db is plaintext now and the backup file is readable by anyone who has it')
  if (plan.keepPrevious) {
    const keyNote = plan.oldKey === null ? '' : `, and its key is in ${input.keyStore?.place ?? 'the key store'} as ${DB_KEY_REPLACED_REF}`
    lines.push(`the store that was here is kept as ${replacedPath(plan.dbPath)}${keyNote}`)
    lines.push(plan.oldKey === null
      ? 'to switch back: stop Kinfold, then move that file over memory.db'
      : "to switch back: stop Kinfold, move that file over memory.db, then run kinfold key recover with that store's recovery code")
  } else if (plan.previous !== 'none') {
    lines.push('the store that was here held no memory and was removed')
  }
  lines.push('the OpenRouter key is not part of a backup: enter it again with kinfold install')
  lines.push('redaction markers written from now on will not match older markers for the same secret, because the HMAC key is not part of a backup; nothing old is lost')
  return lines
}

/**
 * Replaces the store with the staged one. The caller has closed its own
 * connections to memory.db. Resolves once the restored store is in place and
 * the marker is gone; rejects with the reason after putting everything back,
 * or with RestoreStranded when that failed too and the marker is left.
 */
export async function applyRestore(input: RestoreInput): Promise<RestoreOutcome> {
  let plan: Plan
  try {
    plan = checkRestore(input)
  } catch (error: unknown) {
    discardStaged(input.dataDir)
    throw error
  }
  const { dbPath } = plan
  const journal: RestoreJournal = {
    op: 'restore',
    pid: process.pid,
    startedAt: Date.now(),
    previous: plan.previous,
    encrypted: input.staged.key !== null,
    keepPrevious: plan.keepPrevious,
    settings: input.staged.manifest.settings,
  }
  const fault = (point: FaultPoint): void => {
    if (input.faultAt === point) throw new RestoreCrash(point)
  }
  writeRestoreJournal(dbPath, journal)
  try {
    fault('after-journal')
    input.onStep?.('close')
    if (plan.previous !== 'none') await takeExclusive(plan, input)
    if (input.staged.key !== null) storeKey(input.keyStore!, DB_KEY_NEXT_REF, input.staged.key)
    if (plan.keepPrevious && plan.oldKey !== null) storeKey(input.keyStore!, DB_KEY_REPLACED_REF, plan.oldKey)
    fault('after-keys')
    input.onStep?.('swap')
    if (plan.previous === 'none') {
      // Only ever an empty placeholder: fileState called it new.
      rmSync(dbPath, { force: true })
    } else {
      for (const suffix of SIDE_FILES) rmSync(`${dbPath}${suffix}`, { force: true })
      renameSync(dbPath, asidePath(dbPath))
    }
    fault('after-move-aside')
    renameSync(input.staged.path, dbPath)
    fault('after-move-in')
    finish(input.dataDir, input.keyStore, journal, input.log, () => fault('after-key-swap'))
  } catch (error: unknown) {
    if (error instanceof RestoreCrash) throw error
    let end: 'finished' | 'undone'
    try {
      end = settle(input.dataDir, input.keyStore, journal, input.log)
    } catch {
      writeRestoreJournal(dbPath, { ...journal, abandoned: true })
      throw new RestoreStranded('the restore failed partway and could not be put back; nothing was deleted. Run kinfold key resume')
    }
    if (end === 'undone') {
      throw error instanceof BackupError ? error : new BackupError('state', `the restore failed (${error instanceof Error ? error.name : 'error'}); the store that was here is back as it was`)
    }
  }
  return { lines: outcomeLines(input, plan) }
}

export interface ResumeInput {
  dataDir: string
  keyStore: KeyStore | null
  log: (line: string) => void
}

/** `kinfold key resume` for a restore: finishes or undoes it from what is on disk. Throws when the marker is not a restore's, or when neither can be done (nothing is deleted then). */
export function resumeRestore(input: ResumeInput): 'finished' | 'undone' {
  const journal = readRestoreJournal(join(input.dataDir, DB_FILE))
  if (journal === null) throw new BackupError('state', 'no kinfold restore was cut short')
  const end = settle(input.dataDir, input.keyStore, journal, input.log)
  if (end === 'finished') {
    input.log(journal.keepPrevious
      ? `the restore had put the backup in place; it is finished now, and the store that was here is kept as ${replacedPath(join(input.dataDir, DB_FILE))}`
      : 'the restore had put the backup in place; it is finished now')
  } else {
    input.log('the restore had not replaced memory.db; the store that was here is back as it was. Run kinfold restore again to restore the backup')
  }
  return end
}
