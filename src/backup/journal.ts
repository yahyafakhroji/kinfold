// The restore's entry in the maintenance marker. The marker keeps hooks and
// MCP servers off memory.db while it is there (src/sqlite/open.ts), and its
// content is the journal `kinfold key resume` reads to finish or undo a run
// that was killed. It names states and choices only; a key never goes in it.

import { readFileSync } from 'node:fs'
import { isRecord } from '../contract/event'
import { writeFileAtomic } from '../fs/atomic'
import { maintenancePath } from '../sqlite/open'
import { DATA_FILE_MODE } from '../store/data-dir'
import type { BackupManifest } from './archive'

/** How the store was held before the restore: none means there was no store yet. */
export type PreviousStore = 'none' | 'plain' | 'encrypted'

export interface RestoreJournal {
  op: 'restore'
  pid: number
  startedAt: number
  previous: PreviousStore
  /** Whether the restored store is encrypted, so its key travels through db-key-next. */
  encrypted: boolean
  /** The store that was here holds memory and is kept beside the restored one. */
  keepPrevious: boolean
  /** The backup's choices to apply once the store is in place. */
  settings: BackupManifest['settings']
  /** The run gave up with the marker left for `kinfold key resume`; its pid no longer means "still running". */
  abandoned?: boolean
}

export function writeRestoreJournal(dbPath: string, journal: RestoreJournal): void {
  writeFileAtomic(maintenancePath(dbPath), `${JSON.stringify(journal)}\n`, DATA_FILE_MODE)
}

/** The marker's content when it is a restore's; null for a missing or unreadable marker and for any other operation. */
export function readRestoreJournal(dbPath: string): RestoreJournal | null {
  try {
    const value: unknown = JSON.parse(readFileSync(maintenancePath(dbPath), 'utf8'))
    if (!isRecord(value) || value.op !== 'restore' || typeof value.pid !== 'number') return null
    const { previous, encrypted, keepPrevious, settings } = value
    if (previous !== 'none' && previous !== 'plain' && previous !== 'encrypted') return null
    if (typeof encrypted !== 'boolean' || typeof keepPrevious !== 'boolean') return null
    const updateCheck = isRecord(settings) && typeof settings.updateCheck === 'boolean' ? { updateCheck: settings.updateCheck } : {}
    return {
      op: 'restore',
      pid: value.pid,
      startedAt: Number(value.startedAt ?? 0),
      previous,
      encrypted,
      keepPrevious,
      settings: updateCheck,
      ...(value.abandoned === true ? { abandoned: true } : {}),
    }
  } catch {
    return null
  }
}
