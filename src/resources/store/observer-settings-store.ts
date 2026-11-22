// Rows of observer_settings, one per host ('*' is the user default). The
// daemon is the only writer: the installer and the dashboard change a row
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
  /** The base URL of an endpoint provider; absent for every other provider. */
  endpoint?: string
}

export interface ObserverSettingsRow {
  host: string
  provider: string
  model: string
  credentialRef: string | null
  enabled: boolean
  updatedAt: number
  endpoint?: string
}

interface RawRow {
  host: string
  provider: string
  model: string
  credentialRef: string | null
  enabled: number
  updatedAt: number
  endpoint: string | null
}

const COLUMNS = 'host, provider, model, credential_ref AS credentialRef, enabled, updated_at AS updatedAt, endpoint'

/** The endpoint is left out when empty, so a row of any other provider looks as it did before v14. */
function fromRaw({ endpoint, ...row }: RawRow): ObserverSettingsRow {
  return { ...row, enabled: row.enabled !== 0, ...(endpoint === null ? {} : { endpoint }) }
}

export function listObserverSettings(db: Database): ObserverSettingsRow[] {
  return db.query<RawRow, []>(`SELECT ${COLUMNS} FROM observer_settings ORDER BY host`).all().map(fromRaw)
}

/** Insert or replace the host's row; returns it as stored. */
export function upsertObserverSettings(db: Database, input: ObserverSettingsInput, now: number): ObserverSettingsRow {
  const row = db.query<RawRow, Record<string, string | number | null>>(
    `INSERT INTO observer_settings (host, provider, model, credential_ref, enabled, updated_at, endpoint)
     VALUES ($host, $provider, $model, $credentialRef, $enabled, $now, $endpoint)
     ON CONFLICT (host) DO UPDATE SET provider = excluded.provider, model = excluded.model,
       credential_ref = excluded.credential_ref, enabled = excluded.enabled, updated_at = excluded.updated_at,
       endpoint = excluded.endpoint
     RETURNING ${COLUMNS}`,
  ).get({ host: input.host, provider: input.provider, model: input.model, credentialRef: input.credentialRef, enabled: input.enabled ? 1 : 0, now, endpoint: input.endpoint ?? null })
  if (row === null) throw new Error('observer settings upsert returned no row')
  return fromRaw(row)
}
