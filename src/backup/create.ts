// Writing a backup: take the snapshot into a private temp folder inside the
// data folder, describe it in a manifest, and pack both into one file. The
// caller supplies the snapshot (the daemon's worker, or the command line's own
// connection), so this file never sees a key.
//
// What travels besides the store is only what the user chose and no live
// source knows: the update-check choice. The install channel, key-store
// record, host versions, tokens, logs and spool describe this machine and stay
// here.

import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { readInstallRecord } from '../install/setup/record'
import { fileState } from '../sqlite/open'
import { DATA_DIR_MODE } from '../store/data-dir'
import { BACKUP_FORMAT_VERSION, type BackupManifest, BackupError, sha256OfFile, writeArchive } from './archive'
import { writeBackupRecord } from './record'

export const BACKUP_TMP_DIR = 'backup-tmp'
/** A temp file older than this was left by a run that died; no live run takes this long between writes. */
const STALE_TMP_MS = 6 * 60 * 60 * 1000

export interface CreateBackupInput {
  dataDir: string
  /** The file to write; it must not exist. */
  dest: string
  /** Writes the store's snapshot to the path and returns the store's schema version. */
  snapshot: (dest: string) => number | Promise<number>
  version: string
  now: () => number
}

/** A private (0700) folder under the data folder, with files a dead run left behind removed. */
export function privateTmpDir(dataDir: string, name: string, now: number): string {
  const dir = join(dataDir, name)
  mkdirSync(dir, { recursive: true, mode: DATA_DIR_MODE })
  chmodSync(dir, DATA_DIR_MODE)
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    try {
      if (now - statSync(path).mtimeMs > STALE_TMP_MS) rmSync(path, { recursive: true, force: true })
    } catch {
      // Another run removed it first.
    }
  }
  return dir
}

function settingsOf(dataDir: string): BackupManifest['settings'] {
  const record = readInstallRecord(dataDir)
  return record === null ? {} : { updateCheck: record.updateCheck }
}

/** Writes the backup to `dest` and records its time. On any failure nothing is left at `dest` or in the temp folder. */
export async function createBackup(input: CreateBackupInput): Promise<BackupManifest> {
  if (existsSync(input.dest)) throw new BackupError('state', `${input.dest} exists already; choose another name or remove it`)
  const createdAt = input.now()
  const snapshotPath = join(privateTmpDir(input.dataDir, BACKUP_TMP_DIR, createdAt), `snapshot-${randomBytes(8).toString('hex')}.db`)
  const partial = `${input.dest}.partial`
  try {
    const schemaVersion = await input.snapshot(snapshotPath)
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT_VERSION,
      kinfoldVersion: input.version,
      schemaVersion,
      createdAt,
      encrypted: fileState(snapshotPath) === 'encrypted',
      snapshot: { sha256: await sha256OfFile(snapshotPath), bytes: statSync(snapshotPath).size },
      settings: settingsOf(input.dataDir),
    }
    rmSync(partial, { force: true })
    await writeArchive(partial, manifest, snapshotPath)
    // A file that appeared meanwhile is someone else's: the rename would replace it.
    if (existsSync(input.dest)) throw new BackupError('state', `${input.dest} exists already; choose another name or remove it`)
    renameSync(partial, input.dest)
    writeBackupRecord(input.dataDir, createdAt)
    return manifest
  } finally {
    rmSync(partial, { force: true })
    rmSync(snapshotPath, { force: true })
  }
}
