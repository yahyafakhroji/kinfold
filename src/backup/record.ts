// <dataDir>/backup.json: when the last backup was made, for `kinfold status`.
// Missing or malformed reads as "none made", so a damaged file costs nothing.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../contract/event'
import { writeFileAtomic } from '../fs/atomic'
import { DATA_FILE_MODE } from '../store/data-dir'

export const BACKUP_RECORD_FILE = 'backup.json'

export interface BackupRecord {
  /** Milliseconds since the epoch. */
  lastBackupAt: number
}

export function readBackupRecord(dataDir: string): BackupRecord | null {
  const path = join(dataDir, BACKUP_RECORD_FILE)
  if (!existsSync(path)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(value) || typeof value.lastBackupAt !== 'number' || !Number.isFinite(value.lastBackupAt)) return null
    return { lastBackupAt: value.lastBackupAt }
  } catch {
    return null
  }
}

export function writeBackupRecord(dataDir: string, at: number): void {
  writeFileAtomic(join(dataDir, BACKUP_RECORD_FILE), `${JSON.stringify({ lastBackupAt: at })}\n`, DATA_FILE_MODE)
}
