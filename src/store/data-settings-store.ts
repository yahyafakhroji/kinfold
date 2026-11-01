// Rows of data_settings (schema v4): retention days per table and the size
// warning threshold. The daemon is the only writer (D3); the CLI and the
// dashboard change a value through PUT /data/retention. A NULL value means
// "keep forever". Shipped defaults are seeded by the migration with
// updated_at 0, and the same defaults apply if a row is ever missing.

import type { Database } from '../sqlite/types'

export const RETENTION_TABLES = ['events', 'prompts', 'observations', 'summaries'] as const
export type RetentionTable = (typeof RETENTION_TABLES)[number]

/** Days per table; null keeps rows (or text) forever. */
export type RetentionDays = Readonly<Record<RetentionTable, number | null>>

export interface DataSettings {
  retention: RetentionDays
  warnBytes: number
}

export const DEFAULT_RETENTION: RetentionDays = { events: 30, prompts: null, observations: null, summaries: null }
/** REA's SQLite limit, the first tool that stops working as the file grows. */
export const DEFAULT_WARN_BYTES = 256 * 1024 * 1024

const WARN_KEY = 'size.warn_bytes'
const retentionKey = (table: RetentionTable): string => `retention.${table}`

interface Row {
  key: string
  value: number | null
}

export function readDataSettings(db: Database): DataSettings {
  const rows = new Map(db.query<Row, []>('SELECT key, value FROM data_settings').all().map((row) => [row.key, row.value]))
  const retention = Object.fromEntries(
    RETENTION_TABLES.map((table) => [table, rows.has(retentionKey(table)) ? rows.get(retentionKey(table))! : DEFAULT_RETENTION[table]]),
  ) as Record<RetentionTable, number | null>
  return { retention, warnBytes: rows.get(WARN_KEY) ?? DEFAULT_WARN_BYTES }
}

export interface DataSettingsChange {
  retention?: Partial<Record<RetentionTable, number | null>>
  warnBytes?: number
}

function writeSetting(db: Database, key: string, value: number | null, now: number): void {
  db.query(
    `INSERT INTO data_settings (key, value, updated_at) VALUES ($key, $value, $now)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run({ key, value, now })
}

/** Applies only the keys present, in one transaction; returns the settings as stored. */
export function writeDataSettings(db: Database, change: DataSettingsChange, now: number): DataSettings {
  return db.transaction(() => {
    for (const table of RETENTION_TABLES) {
      const days = change.retention?.[table]
      if (days !== undefined) writeSetting(db, retentionKey(table), days, now)
    }
    if (change.warnBytes !== undefined) writeSetting(db, WARN_KEY, change.warnBytes, now)
    return readDataSettings(db)
  })()
}
