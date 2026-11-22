// The daemon's record of which CLI login observers passed the planted-
// instruction test (src/observer/safety-gate.ts). A row is keyed on provider,
// CLI version and resolved binary path, so a CLI update or a different binary
// on PATH is a new key that gets its own test. Only the daemon writes here.

import type { CliLoginProvider } from '../observer/types'
import type { Database } from '../sqlite/types'

export interface SafetyKey {
  provider: CliLoginProvider
  cliVersion: string
  binaryPath: string
}

export type SafetyStatus = 'passed' | 'failed'

export interface SafetyRow extends SafetyKey {
  status: SafetyStatus
  errorClass: string | null
  checkedAt: number
}

const COLUMNS = `provider, cli_version AS cliVersion, binary_path AS binaryPath, status, error_class AS errorClass, checked_at AS checkedAt`

export function getSafety(db: Database, key: SafetyKey): SafetyRow | null {
  return db.query<SafetyRow, Record<string, string>>(
    `SELECT ${COLUMNS} FROM observer_safety
     WHERE provider = $provider AND cli_version = $cliVersion AND binary_path = $binaryPath`,
  ).get({ ...key })
}

/** Inserts or replaces the row for this key; a `passed` row also deletes the provider's failed rows. */
export function recordSafety(db: Database, key: SafetyKey, status: SafetyStatus, errorClass: string | null, now: number): void {
  db.transaction(() => {
    upsert(db, key, status, errorClass, now)
    // A pass retires the provider's older failures (a CLI upgrade), so the page never shows a stale Stopped.
    if (status === 'passed') clearFailedSafety(db, key.provider)
  })()
}

function upsert(db: Database, key: SafetyKey, status: SafetyStatus, errorClass: string | null, now: number): void {
  db.query(
    `INSERT INTO observer_safety (provider, cli_version, binary_path, status, error_class, checked_at)
     VALUES ($provider, $cliVersion, $binaryPath, $status, $errorClass, $now)
     ON CONFLICT (provider, cli_version, binary_path) DO UPDATE SET
       status = excluded.status, error_class = excluded.error_class, checked_at = excluded.checked_at`,
  ).run({ ...key, status, errorClass, now })
}

/** Forgets a provider's failed rows (a re-saved choice or a Re-check), so its next batch tests again. Returns the count. */
export function clearFailedSafety(db: Database, provider: CliLoginProvider): number {
  return db.query("DELETE FROM observer_safety WHERE provider = $provider AND status = 'failed'").run({ provider }).changes
}

export function listSafety(db: Database): SafetyRow[] {
  return db.query<SafetyRow, []>(`SELECT ${COLUMNS} FROM observer_safety ORDER BY provider, cli_version, binary_path`).all()
}
