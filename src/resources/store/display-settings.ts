// Two global switches in data_settings (schema v12): whether agents show what
// Kinfold recalled (the line after a prompt and the list at session start),
// and whether the opt-in impact test holds back recall on some prompts. Both
// are stored as 0 or 1. `impact.since` is when this store reached v12, the
// date the impact numbers start from; nothing but the migration writes it.
// A missing row reads as its default, so a store that lost one still works.

import type { Database } from '../sqlite/types'

export interface DisplaySettings {
  showRecall: boolean
  holdout: boolean
  /** Epoch ms the impact numbers count from; null on a store that never recorded it. */
  since: number | null
}

export interface DisplayChange {
  showRecall?: boolean
  holdout?: boolean
}

const SHOW_KEY = 'display.show_recall'
const HOLDOUT_KEY = 'impact.holdout'
const SINCE_KEY = 'impact.since'

export const DEFAULT_DISPLAY: Pick<DisplaySettings, 'showRecall' | 'holdout'> = { showRecall: true, holdout: false }

export function readDisplaySettings(db: Database): DisplaySettings {
  const rows = new Map(
    db.query<{ key: string; value: number | null }, [string, string, string]>('SELECT key, value FROM data_settings WHERE key IN (?, ?, ?)')
      .all(SHOW_KEY, HOLDOUT_KEY, SINCE_KEY).map((row) => [row.key, row.value]),
  )
  const flag = (key: string, fallback: boolean): boolean => {
    const value = rows.get(key)
    return value === undefined || value === null ? fallback : value !== 0
  }
  return { showRecall: flag(SHOW_KEY, DEFAULT_DISPLAY.showRecall), holdout: flag(HOLDOUT_KEY, DEFAULT_DISPLAY.holdout), since: rows.get(SINCE_KEY) ?? null }
}

/** Applies only the keys present, in one transaction; returns the settings as stored. */
export function writeDisplaySettings(db: Database, change: DisplayChange, now: number): DisplaySettings {
  const write = db.query(
    `INSERT INTO data_settings (key, value, updated_at) VALUES ($key, $value, $now)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )
  return db.transaction(() => {
    if (change.showRecall !== undefined) write.run({ key: SHOW_KEY, value: change.showRecall ? 1 : 0, now })
    if (change.holdout !== undefined) write.run({ key: HOLDOUT_KEY, value: change.holdout ? 1 : 0, now })
    return readDisplaySettings(db)
  })()
}
