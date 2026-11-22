import { afterEach, beforeEach, expect, test } from 'bun:test'
import { finishRun, startRun } from '../../store/observer-store'
import { upsertObserverSettings } from '../../store/observer-settings-store'
import { BACKOFF_FIRST_MS, BACKOFF_MAX_MS, backoffDelayMs, backoffLine, backsOff, clearBackoff, ensureBackoffIndex, providerBackoff, providerBackoffs, returnsToPending } from '../../observer/backoff'
import { type TempStore, T0, openTempStore, seedSession } from './test-support'

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('kinfold-backoff-')
  session = seedSession(temp.store, 'claude-code', 's1')
})
afterEach(() => temp.cleanup())

function run(provider: string, at: number, error: string | null): void {
  const id = startRun(temp.store.db, { sessionId: session, host: 'claude-code', provider, model: 'haiku', eventCount: 1, startedAt: at })
  finishRun(temp.store.db, id, error === null ? 'succeeded' : 'failed', error, at + 2_000)
}

test('the wait doubles from a minute and stops at an hour', () => {
  expect(backoffDelayMs(1)).toBe(BACKOFF_FIRST_MS)
  expect(backoffDelayMs(2)).toBe(2 * BACKOFF_FIRST_MS)
  expect(backoffDelayMs(6)).toBe(32 * BACKOFF_FIRST_MS)
  expect(backoffDelayMs(7)).toBe(BACKOFF_MAX_MS)
  expect(backoffDelayMs(1_300)).toBe(BACKOFF_MAX_MS)
})

test('only failures of the provider itself back off; a bad reply to one batch does not', () => {
  for (const errorClass of ['exit_nonzero', 'cli_missing', 'credential_missing', 'timeout', 'http_error', 'auth_expired', 'not_logged_in', 'rate_limited']) expect(backsOff(errorClass)).toBe(true)
  for (const errorClass of ['bad_output', 'interrupted', 'tool_attempt', 'safety_check_failed']) expect(backsOff(errorClass)).toBe(false)
})

test('only failures that cannot belong to one batch keep its events pending; the rest still count attempts', () => {
  for (const errorClass of ['auth_expired', 'not_logged_in', 'rate_limited', 'cli_missing', 'credential_missing', 'credential_error', 'config_invalid']) expect(returnsToPending(errorClass)).toBe(true)
  // A prompt too large for the time limit, or a reply that breaks a write, fails the same batch every time.
  for (const errorClass of ['exit_nonzero', 'timeout', 'internal', 'bad_response', 'http_error', 'bad_output']) expect(returnsToPending(errorClass)).toBe(false)
})

test('a login that expired or is missing waits the full hour at once', () => {
  run('claude-cli', T0, 'auth_expired: claude exited 1: Failed to authenticate: OAuth session expired')
  expect(providerBackoff(temp.store.db, 'claude-cli')).toMatchObject({ failures: 1, retryAt: T0 + 2_000 + BACKOFF_MAX_MS })
})

test('a passed observer test or a new credential clears the wait, for that provider only', () => {
  run('claude-cli', T0, 'exit_nonzero: claude exited 1')
  run('codex-cli', T0, 'exit_nonzero: exited 1')
  clearBackoff(temp.store.db, 'claude-cli', T0 + 5_000)
  expect(providerBackoff(temp.store.db, 'claude-cli')).toBeNull()
  expect(providerBackoff(temp.store.db, 'codex-cli')).toMatchObject({ failures: 1 })
  run('claude-cli', T0 + 10_000, 'exit_nonzero: claude exited 1')
  expect(providerBackoff(temp.store.db, 'claude-cli')).toMatchObject({ failures: 1, since: T0 + 10_000 })
})

test('a settings change for another provider leaves this one waiting', () => {
  run('claude-cli', T0, 'exit_nonzero: claude exited 1')
  upsertObserverSettings(temp.store.db, { host: 'opencode', provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true }, T0 + 5_000)
  expect(providerBackoff(temp.store.db, 'claude-cli')).toMatchObject({ failures: 1 })
})

test('the provider index can be made more than once', () => {
  ensureBackoffIndex(temp.store.db)
  ensureBackoffIndex(temp.store.db)
  expect(temp.store.db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'observer_runs_by_provider'").all()).toHaveLength(1)
})

test('a run of the same failure counts from the last success, and the retry waits from the last failure', () => {
  run('claude-cli', T0, null)
  run('claude-cli', T0 + 10_000, 'exit_nonzero: claude exited 1')
  run('claude-cli', T0 + 20_000, 'exit_nonzero: claude exited 1')
  run('claude-cli', T0 + 30_000, 'exit_nonzero: claude exited 1')
  run('openrouter', T0 + 40_000, null)
  expect(providerBackoff(temp.store.db, 'claude-cli')).toEqual({
    provider: 'claude-cli', errorClass: 'exit_nonzero', failures: 3, since: T0 + 10_000, lastFailedAt: T0 + 32_000, retryAt: T0 + 32_000 + 4 * BACKOFF_FIRST_MS,
  })
  expect(providerBackoff(temp.store.db, 'openrouter')).toBeNull()
  expect(providerBackoffs(temp.store.db).map((entry) => entry.provider)).toEqual(['claude-cli'])
  run('claude-cli', T0 + 50_000, null)
  expect(providerBackoff(temp.store.db, 'claude-cli')).toBeNull()
})

test('another error class starts a new count; a daemon restart in between does not', () => {
  run('claude-cli', T0, 'timeout: no answer')
  run('claude-cli', T0 + 10_000, 'exit_nonzero: claude exited 1')
  run('claude-cli', T0 + 20_000, 'interrupted: daemon stopped mid-run')
  run('claude-cli', T0 + 30_000, 'exit_nonzero: claude exited 1')
  expect(providerBackoff(temp.store.db, 'claude-cli')).toMatchObject({ errorClass: 'exit_nonzero', failures: 2, since: T0 + 10_000 })
  run('claude-cli', T0 + 40_000, 'bad_output: not JSON')
  expect(providerBackoff(temp.store.db, 'claude-cli')).toBeNull()
})

test('a settings change after the last failure clears the wait; failures after it count again', () => {
  run('claude-cli', T0, 'exit_nonzero: claude exited 1')
  run('claude-cli', T0 + 10_000, 'exit_nonzero: claude exited 1')
  upsertObserverSettings(temp.store.db, { host: 'claude-code', provider: 'claude-cli', model: 'sonnet', credentialRef: null, enabled: true }, T0 + 20_000)
  expect(providerBackoff(temp.store.db, 'claude-cli')).toBeNull()
  run('claude-cli', T0 + 30_000, 'exit_nonzero: claude exited 1')
  expect(providerBackoff(temp.store.db, 'claude-cli')).toMatchObject({ failures: 1, since: T0 + 30_000 })
})

test('the status line says how often, since when, when it tries next and what to check', () => {
  const entry = { provider: 'claude-cli', errorClass: 'exit_nonzero', failures: 1300, since: T0, lastFailedAt: T0 + 5_000, retryAt: T0 + 5_000 + BACKOFF_MAX_MS }
  const line = backoffLine(entry, T0 + 10_000)
  expect(line).toMatch(/^claude-cli has failed 1300 times since .+: exit_nonzero; retrying at .+; check `claude` works in a terminal$/)
  expect(backoffLine({ ...entry, failures: 1 }, T0 + 10_000)).toContain('has failed 1 time since')
  expect(backoffLine(entry, entry.retryAt + 1)).toContain('; retrying with its next batch;')
  expect(backoffLine({ ...entry, provider: 'openrouter', errorClass: 'http_error' }, T0)).toMatch(/; check its key and settings in the dashboard$/)
})

test('with a long-lived token in use, a login problem says to run claude setup-token again, not to log in', () => {
  const entry = { provider: 'claude-cli', errorClass: 'auth_expired', failures: 2, since: T0, lastFailedAt: T0, retryAt: T0 + BACKOFF_MAX_MS }
  const line = backoffLine(entry, T0, { claudeToken: true })
  expect(line).toStartWith('claude-cli: the long-lived token Kinfold uses has expired or was revoked; run `claude setup-token` again and store the new token (kinfold install --observer-token-stdin, or Settings in the dashboard).')
  expect(line).not.toContain('claude auth login')
  expect(backoffLine({ ...entry, errorClass: 'not_logged_in' }, T0, { claudeToken: true })).toContain('run `claude setup-token` again')
  // The token is claude-cli's only.
  expect(backoffLine({ ...entry, provider: 'codex-cli' }, T0, { claudeToken: true })).toContain('`codex login`')
})

test('a login problem says what to run, and where', () => {
  const entry = { provider: 'claude-cli', errorClass: 'auth_expired', failures: 4, since: T0, lastFailedAt: T0, retryAt: T0 + BACKOFF_MAX_MS }
  expect(backoffLine(entry, T0)).toMatch(/^claude-cli: the login Kinfold uses has expired; run `claude auth login` in a plain terminal \(not one with CLAUDE_CONFIG_DIR set\), or store a long-lived token from `claude setup-token` with kinfold install --observer-token-stdin\. Failed 4 times since .+; retrying at .+$/)
  expect(backoffLine({ ...entry, errorClass: 'not_logged_in' }, T0)).toStartWith('claude-cli: the CLI Kinfold runs is not logged in; run `claude auth login` in a plain terminal (not one with CLAUDE_CONFIG_DIR set), or store')
  expect(backoffLine({ ...entry, provider: 'codex-cli' }, T0)).toStartWith('codex-cli: the login Kinfold uses has expired; run `codex login` in a plain terminal (not one with CODEX_HOME set).')
  expect(backoffLine({ ...entry, errorClass: 'rate_limited' }, T0)).toMatch(/^claude-cli has failed 4 times since .+: rate_limited \(a usage limit\); retrying at .+$/)
})

test('the streak is counted from the newest run that broke it, found without reading the provider\'s older runs', () => {
  ensureBackoffIndex(temp.store.db)
  // A long history: successes, then another class, a restart in between, then the streak.
  for (let index = 0; index < 400; index += 1) run('claude-cli', T0 + index * 10_000, index % 3 === 0 ? 'timeout: after 120 s' : null)
  const from = T0 + 400 * 10_000
  run('claude-cli', from, 'http_error: 500')
  run('claude-cli', from + 10_000, 'timeout: after 120 s')
  run('claude-cli', from + 20_000, 'interrupted: daemon restart')
  run('claude-cli', from + 30_000, 'timeout: after 120 s')
  expect(providerBackoff(temp.store.db, 'claude-cli')).toMatchObject({ errorClass: 'timeout', failures: 2, since: from + 10_000, lastFailedAt: from + 32_000 })

  // The boundary read walks (provider, id) backward and stops: it neither scans the table nor builds a sorted copy.
  const detail = temp.store.db.query<{ detail: string }, { provider: string; errorClass: string; restart: string }>(
    `EXPLAIN QUERY PLAN SELECT id FROM observer_runs WHERE provider = $provider AND status <> 'running'
       AND (status = 'succeeded' OR error IS NULL OR substr(error, 1, instr(error, ':') - 1) NOT IN ($errorClass, $restart)) ORDER BY id DESC LIMIT 1`,
  ).all({ provider: 'claude-cli', errorClass: 'timeout', restart: 'interrupted' }).map((row) => row.detail).join('\n')
  expect(detail).toContain('observer_runs_by_provider')
  expect(detail).not.toContain('TEMP B-TREE')
})
