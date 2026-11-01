// Rows of observer_settings, one per host ('*' is the user default). The
// daemon is the only writer (D3): the installer and the dashboard change a row
// through PUT /observer/settings, and the observer reads it on its next batch.
// A credential_ref names a keychain entry; no secret is ever stored here.

import type { ObserverProvider } from '../observer/types'
import type { Database } from '../sqlite/types'

export interface ObserverSettingsInput {
  host: string
  provider: ObserverProvider
  model: string
  credentialRef: string | null
  enabled: boolean
}

export interface ObserverSettingsRow {
  host: string
  provider: string
  model: string
  credentialRef: string | null
  enabled: boolean
  updatedAt: number
}

interface RawRow {
  host: string
  provider: string
  model: string
  credentialRef: string | null
  enabled: number
  updatedAt: number
}

const COLUMNS = 'host, provider, model, credential_ref AS credentialRef, enabled, updated_at AS updatedAt'

function fromRaw(row: RawRow): ObserverSettingsRow {
  return { ...row, enabled: row.enabled !== 0 }
}

export function listObserverSettings(db: Database): ObserverSettingsRow[] {
  return db.query<RawRow, []>(`SELECT ${COLUMNS} FROM observer_settings ORDER BY host`).all().map(fromRaw)
}

/** Insert or replace the host's row; returns it as stored. */
export function upsertObserverSettings(db: Database, input: ObserverSettingsInput, now: number): ObserverSettingsRow {
  const row = db.query<RawRow, Record<string, string | number | null>>(
    `INSERT INTO observer_settings (host, provider, model, credential_ref, enabled, updated_at)
     VALUES ($host, $provider, $model, $credentialRef, $enabled, $now)
     ON CONFLICT (host) DO UPDATE SET provider = excluded.provider, model = excluded.model,
       credential_ref = excluded.credential_ref, enabled = excluded.enabled, updated_at = excluded.updated_at
     RETURNING ${COLUMNS}`,
  ).get({ ...input, enabled: input.enabled ? 1 : 0, now })
  if (row === null) throw new Error('observer settings upsert returned no row')
  return fromRaw(row)
}
