// Backoff for an observer provider that keeps failing. A provider whose login
// or CLI broke fails every batch the same way, and retrying each batch at once
// made about 1,300 failed runs a day on one machine. The state is read from
// observer_runs, so it survives a restart and needs no schema change: the
// failed runs of one error class since the provider's last success, its last
// settings change or its last clear (a passed observer test, a new
// credential) set the wait, doubling from a minute up to an hour. A login
// that expired or is missing waits the full hour at once, since nothing but
// the user can fix it. Clears live in data_settings, one key per provider, so
// an older build that opens the same store sees nothing it does not know.

import type { Database } from '../sqlite/types'

export const BACKOFF_FIRST_MS = 60_000
export const BACKOFF_MAX_MS = 3_600_000

/**
 * Failures that say the provider itself is broken, so every batch would fail
 * the same way. A bad reply belongs to one batch; an interrupted run to a
 * restart; tool attempts and safety checks have their own gate.
 */
const PROVIDER_CLASSES: ReadonlySet<string> = new Set([
  'credential_missing', 'credential_error', 'cli_missing', 'exit_nonzero', 'timeout', 'http_error', 'bad_response', 'config_invalid', 'internal',
  'auth_expired', 'not_logged_in', 'rate_limited',
])

/**
 * Failures that say nothing about the batch, so its events go back to pending
 * with no attempt counted. A timeout, a crash or an odd reply can come from
 * one batch (a prompt too large, a reply that breaks a write), so those still
 * count, or such a batch would be tried forever.
 */
const PENDING_CLASSES: ReadonlySet<string> = new Set([
  'auth_expired', 'not_logged_in', 'rate_limited', 'cli_missing', 'credential_missing', 'credential_error', 'config_invalid',
])

const LOGIN_CLASSES: ReadonlySet<string> = new Set(['auth_expired', 'not_logged_in'])

/** The class that neither continues nor breaks a run of failures. */
const RESTART_CLASS = 'interrupted'

export function backsOff(errorClass: string): boolean {
  return PROVIDER_CLASSES.has(errorClass)
}

export function returnsToPending(errorClass: string): boolean {
  return PENDING_CLASSES.has(errorClass)
}

export function backoffDelayMs(failures: number, errorClass?: string): number {
  if (errorClass !== undefined && LOGIN_CLASSES.has(errorClass)) return BACKOFF_MAX_MS
  const doublings = Math.min(Math.max(failures - 1, 0), 30)
  return Math.min(BACKOFF_FIRST_MS * 2 ** doublings, BACKOFF_MAX_MS)
}

export interface ProviderBackoff {
  provider: string
  errorClass: string
  failures: number
  /** When the first failed run of this streak started. */
  since: number
  lastFailedAt: number
  /** No batch for this provider starts before this time. */
  retryAt: number
}

const CLASS_OF = "substr(error, 1, instr(error, ':') - 1)"

interface LatestRow {
  status: string
  errorClass: string | null
  at: number
}

/** The provider's current streak of same-class failures, or null when it has none. */
export function providerBackoff(db: Database, provider: string): ProviderBackoff | null {
  const latest = db.query<LatestRow, { provider: string; restart: string }>(
    `SELECT status, ${CLASS_OF} AS errorClass, coalesce(finished_at, started_at) AS at FROM observer_runs
     WHERE provider = $provider AND status <> 'running' AND (error IS NULL OR ${CLASS_OF} <> $restart)
     ORDER BY id DESC LIMIT 1`,
  ).get({ provider, restart: RESTART_CLASS })
  if (latest === null || latest.status !== 'failed' || latest.errorClass === null || !backsOff(latest.errorClass)) return null
  const settingsAt = Math.max(
    db.query<{ at: number }, { provider: string }>('SELECT coalesce(max(updated_at), 0) AS at FROM observer_settings WHERE provider = $provider').get({ provider })?.at ?? 0,
    db.query<{ at: number | null }, { key: string }>('SELECT value AS at FROM data_settings WHERE key = $key').get({ key: clearKey(provider) })?.at ?? 0,
  )
  if (latest.at <= settingsAt) return null
  // The streak starts after the newest run that broke it. That run is found by walking (provider, id) from the newest
  // and stopping at the first match: max(id) over the same filter read every run the provider ever made, on a table
  // that is never pruned, several times per batch while a provider fails.
  const streak = db.query<{ failures: number; since: number | null }, { provider: string; errorClass: string; restart: string; settingsAt: number }>(
    `SELECT count(*) AS failures, min(started_at) AS since FROM observer_runs
     WHERE provider = $provider AND status = 'failed' AND ${CLASS_OF} = $errorClass AND coalesce(finished_at, started_at) > $settingsAt
       AND id > coalesce((SELECT id FROM observer_runs
                 WHERE provider = $provider AND status <> 'running'
                   AND (status = 'succeeded' OR error IS NULL OR ${CLASS_OF} NOT IN ($errorClass, $restart))
                 ORDER BY id DESC LIMIT 1), 0)`,
  ).get({ provider, errorClass: latest.errorClass, restart: RESTART_CLASS, settingsAt })
  if (streak === null || streak.failures === 0 || streak.since === null) return null
  return { provider, errorClass: latest.errorClass, failures: streak.failures, since: streak.since, lastFailedAt: latest.at, retryAt: latest.at + backoffDelayMs(streak.failures, latest.errorClass) }
}

const clearKey = (provider: string): string => `observer.backoff_cleared.${provider}`

/** Forgets the provider's failures up to now: a passed observer test or a new credential may have fixed it. */
export function clearBackoff(db: Database, provider: string, now: number): void {
  db.query(
    `INSERT INTO data_settings (key, value, updated_at) VALUES ($key, $now, $now)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run({ key: clearKey(provider), now })
}

/** The streak queries filter by provider; IF NOT EXISTS keeps it out of the numbered migrations, so an older build can still open the store. */
export function ensureBackoffIndex(db: Database): void {
  db.run('CREATE INDEX IF NOT EXISTS observer_runs_by_provider ON observer_runs(provider, id)')
}

/** Every provider with a streak, for status and the dashboard. */
export function providerBackoffs(db: Database): ProviderBackoff[] {
  const providers = db.query<{ provider: string }, []>('SELECT DISTINCT provider FROM observer_runs ORDER BY provider').all()
  return providers.flatMap(({ provider }) => {
    const entry = providerBackoff(db, provider)
    return entry === null ? [] : [entry]
  })
}

/** The command a CLI login provider runs, so the line can say what to try by hand. */
const CLI_COMMANDS: Readonly<Record<string, string>> = { 'claude-cli': 'claude', 'codex-cli': 'codex', 'opencode-cli': 'opencode', 'goose-cli': 'goose' }

function when(ms: number): string {
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** How to log in again, run where the daemon's own config folder is used. */
const LOGIN_FIX: Readonly<Record<string, string>> = {
  'claude-cli': 'run `claude auth login` in a plain terminal (not one with CLAUDE_CONFIG_DIR set), or store a long-lived token from `claude setup-token` with kinfold install --observer-token-stdin',
  'codex-cli': 'run `codex login` in a plain terminal (not one with CODEX_HOME set)',
  'opencode-cli': 'run `opencode auth login` in a plain terminal',
  'goose-cli': 'run `goose configure` in a plain terminal',
}

/** What a token from `claude setup-token` needs once it stops working: a new token, since logging the CLI in again changes nothing the observer uses. */
const TOKEN_FIX = 'run `claude setup-token` again and store the new token (kinfold install --observer-token-stdin, or Settings in the dashboard)'

export interface BackoffLineOptions {
  /** The claude-cli observer runs on a stored long-lived token. */
  claudeToken?: boolean
}

export function backoffLine(entry: ProviderBackoff, now: number, options: BackoffLineOptions = {}): string {
  const times = entry.failures === 1 ? 'time' : 'times'
  const next = entry.retryAt > now ? `retrying at ${when(entry.retryAt)}` : 'retrying with its next batch'
  const fix = LOGIN_FIX[entry.provider]
  if (LOGIN_CLASSES.has(entry.errorClass) && entry.provider === 'claude-cli' && options.claudeToken === true) {
    return `${entry.provider}: the long-lived token Kinfold uses has expired or was revoked; ${TOKEN_FIX}. Failed ${entry.failures} ${times} since ${when(entry.since)}; ${next}`
  }
  if (LOGIN_CLASSES.has(entry.errorClass) && fix !== undefined) {
    const what = entry.errorClass === 'auth_expired' ? 'the login Kinfold uses has expired' : 'the CLI Kinfold runs is not logged in'
    return `${entry.provider}: ${what}; ${fix}. Failed ${entry.failures} ${times} since ${when(entry.since)}; ${next}`
  }
  const head = `${entry.provider} has failed ${entry.failures} ${times} since ${when(entry.since)}`
  if (entry.errorClass === 'rate_limited') return `${head}: rate_limited (a usage limit); ${next}`
  const command = CLI_COMMANDS[entry.provider]
  const check = command === undefined ? 'check its key and settings in the dashboard' : `check \`${command}\` works in a terminal`
  return `${head}: ${entry.errorClass}; ${next}; ${check}`
}
