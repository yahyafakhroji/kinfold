// GET and PUT /observer/settings (the daemon is the single writer).
// The installer saves each host's observer choice here, and the dashboard will
// reuse the same routes. PUT checks everything resolveObserverSettings would
// later refuse, so a stored row never fails a batch as config_invalid. Errors
// name the field, never echo its value.

import type { Parsed } from '../context/types'
import { backoffLine, clearBackoff, providerBackoffs } from '../observer/backoff'
import type { ProbeFailure } from '../observer/safety-gate'
import { KNOWN_HOSTS, isRecord } from '../contract/event'
import { checkEndpoint } from '../observer/endpoint'
import { parseGooseModel } from '../observer/runners/goose-cli'
import { CLAUDE_TOKEN_REF, credentialRefProblem, isEndpointProvider, providerTakesKey, resolveObserverSettings } from '../observer/settings'
import { CLI_LOGIN_PROVIDERS, type CliLoginProvider, OBSERVER_PROVIDERS, type ObserverProvider, type ObserverSettings, toObserverError, isCliLoginProvider } from '../observer/types'
import { assertCredentialRef, assertStorableValue, isSystemCredentialRef } from '../secrets/credentials'
import type { KeyStore } from '../secrets/key-store'
import { type SafetyRow, clearFailedSafety, listSafety } from '../store/observer-safety-store'
import type { Database } from '../sqlite/types'
import { type ObserverSettingsInput, type ObserverSettingsRow, listObserverSettings, upsertObserverSettings } from '../store/observer-settings-store'

const HOST_PATTERN = /^(\*|[a-z0-9][a-z0-9._-]{0,63})$/
export const MAX_MODEL_CHARS = 200
/**
 * Hosts whose effective setting GET always reports, row or not. Every host the
 * contract knows is listed, so Codex and Cursor can be set before they are installed.
 */
export const REPORTED_HOSTS = KNOWN_HOSTS

export type EffectiveSettings = { host: string } & ({ settings: ObserverSettings } | { error: string })

/** A safety row as the page sees it: the resolved binary path stays in the daemon. */
export type SafetyView = Omit<SafetyRow, 'binaryPath'>

export interface ObserverSettingsView {
  rows: ObserverSettingsRow[]
  safety: SafetyView[]
  /** The safety gate's last probe failure per CLI provider; kept in memory only, never a row. */
  probe: ProbeFailure[]
  /** Providers that keep failing and wait between tries (observer/backoff.ts). */
  backoff: BackoffView[]
  effective: EffectiveSettings[]
  /** What the claude-cli observer signs in with: a stored long-lived token, the CLI's own login, or unknown when the key store cannot be asked. */
  claudeAuth: ClaudeAuth
}

export type ClaudeAuth = 'token' | 'login' | 'unknown'

/** The claude-cli observer's long-lived token in the key store; the value goes in and never comes back out. */
export interface ObserverToken {
  auth(): ClaudeAuth
  set(value: string): void
  clear(): void
}

export function keyStoreToken(store: KeyStore | null): ObserverToken | null {
  if (store === null) return null
  return {
    auth: () => {
      try {
        // Metadata only: whether an entry exists, never its value.
        return store.exists(CLAUDE_TOKEN_REF) ? 'token' : 'login'
      } catch {
        return 'unknown'
      }
    },
    set: (value) => store.set(CLAUDE_TOKEN_REF, value),
    clear: () => void store.delete(CLAUDE_TOKEN_REF),
  }
}

/** A pasted token: surrounding space and line ends go; the rest must be one storable value. The value is never echoed. */
export function parseTokenPut(body: unknown): Parsed<string> {
  if (!isRecord(body) || typeof body.token !== 'string') return { ok: false, error: 'token must be a string' }
  const value = body.token.trim()
  try {
    assertStorableValue(value)
  } catch {
    return { ok: false, error: 'token must be 1 to 512 printable characters without spaces or quotes' }
  }
  return { ok: true, value }
}

export interface BackoffView {
  provider: string
  errorClass: string
  failures: number
  since: number
  retryAt: number
  /** The sentence status and the dashboard show, written once here so both say the same. */
  line: string
}

export interface ObserverSettingsHandlers {
  list: () => ObserverSettingsView
  put: (input: ObserverSettingsInput) => ObserverSettingsRow
  /** Forgets a CLI provider's failed safety rows so its next batch tests again; returns the count. */
  recheck: (provider: CliLoginProvider) => number
  /** The claude-cli token; null when this daemon has no key store to keep it in. */
  token: { auth: () => ClaudeAuth; save: (value: string) => void; remove: () => void } | null
}

/** POST /observer/recheck body. The error names the field and never echoes the value. */
export function parseRecheck(body: unknown): Parsed<CliLoginProvider> {
  const provider = isRecord(body) ? body.provider : undefined
  if (!isCliLoginProvider(provider)) return { ok: false, error: `provider must be one of ${CLI_LOGIN_PROVIDERS.join(', ')}` }
  return { ok: true, value: provider }
}

function parseCredentialRef(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: 'credentialRef must be a string or null' }
  try {
    assertCredentialRef(value)
  } catch {
    return { ok: false, error: 'credentialRef must be a short lowercase name' }
  }
  if (isSystemCredentialRef(value)) return { ok: false, error: 'credentialRef names a key Kinfold keeps for itself' }
  return { ok: true, value }
}

export function parseSettingsPut(body: unknown): Parsed<ObserverSettingsInput> {
  if (!isRecord(body)) return { ok: false, error: 'body must be a JSON object' }
  const { host, provider, model, enabled } = body
  if (typeof host !== 'string' || !HOST_PATTERN.test(host)) return { ok: false, error: 'host must be "*" or a short lowercase name' }
  if (!OBSERVER_PROVIDERS.includes(provider as ObserverProvider)) {
    return { ok: false, error: `provider must be one of ${OBSERVER_PROVIDERS.join(', ')}` }
  }
  if (typeof model !== 'string' || model.trim() === '' || model.length > MAX_MODEL_CHARS) {
    return { ok: false, error: 'model must be a non-empty string' }
  }
  if (enabled !== undefined && typeof enabled !== 'boolean') return { ok: false, error: 'enabled must be a boolean' }
  const ref = parseCredentialRef(body.credentialRef)
  if (!ref.ok) return ref
  const known = provider as ObserverProvider
  if (known === 'goose-cli') {
    const goose = parseGooseModel(model.trim())
    if (!goose.ok) return goose
  }
  const endpoint = parseEndpoint(known, body.endpoint)
  if (!endpoint.ok) return endpoint
  const credentialRef = providerTakesKey(known) ? ref.value : null
  const refProblem = credentialRef === null ? null : credentialRefProblem(known, credentialRef)
  if (refProblem !== null) return { ok: false, error: `credentialRef ${refProblem}` }
  const value: ObserverSettingsInput = { host, provider: known, model: model.trim(), credentialRef, enabled: enabled ?? true }
  return { ok: true, value: endpoint.value === null ? value : { ...value, endpoint: endpoint.value } }
}

/** The checked endpoint of an endpoint provider; null for any other, whose endpoint is dropped. */
function parseEndpoint(provider: ObserverProvider, value: unknown): Parsed<string | null> {
  if (!isEndpointProvider(provider)) return { ok: true, value: null }
  if (value === undefined || value === null || value === '') return { ok: false, error: `endpoint is needed for ${provider}` }
  if (typeof value !== 'string') return { ok: false, error: 'endpoint must be a string' }
  const checked = checkEndpoint(provider, value)
  return checked.ok ? checked : { ok: false, error: checked.error }
}

function effectiveFor(db: Database, host: string): EffectiveSettings {
  try {
    return { host, settings: resolveObserverSettings(db, host) }
  } catch (error: unknown) {
    return { host, error: toObserverError(error).errorClass }
  }
}

export function observerSettingsView(db: Database, probe: readonly ProbeFailure[] = [], now: number = Date.now(), claudeAuth: ClaudeAuth = 'login'): ObserverSettingsView {
  const rows = listObserverSettings(db)
  const hosts = [...new Set([...REPORTED_HOSTS, ...rows.map((row) => row.host).filter((host) => host !== '*')])]
  const safety = listSafety(db).map(({ binaryPath: _binaryPath, ...rest }) => rest)
  const backoff = providerBackoffs(db).map((entry) => ({
    provider: entry.provider, errorClass: entry.errorClass, failures: entry.failures, since: entry.since, retryAt: entry.retryAt, line: backoffLine(entry, now, { claudeToken: claudeAuth === 'token' }),
  }))
  return { rows, safety, probe: probe.map(({ provider, errorClass }) => ({ provider, errorClass })), backoff, effective: hosts.map((host) => effectiveFor(db, host)), claudeAuth }
}

/** Logs the host and provider only. `probeFailures` is the safety gate's in-memory list, when the daemon observes. */
export function settingsHandlers(db: Database, now: () => number, log: (line: string) => void, probeFailures: () => readonly ProbeFailure[] = () => [], token: ObserverToken | null = null): ObserverSettingsHandlers {
  return {
    list: () => observerSettingsView(db, probeFailures(), now(), token?.auth() ?? 'login'),
    token: token === null ? null : {
      auth: () => token.auth(),
      save: (value) => {
        token.set(value)
        // A new credential is the user's answer to a login that stopped working: the next batch tries at once.
        clearBackoff(db, 'claude-cli', now())
        log('observer claude-cli token saved')
      },
      remove: () => {
        token.clear()
        clearBackoff(db, 'claude-cli', now())
        log('observer claude-cli token removed')
      },
    },
    put: (input) => {
      const row = upsertObserverSettings(db, input, now())
      // Saving a CLI choice is the user's answer to a stopped observer, even when the row is unchanged.
      if (isCliLoginProvider(row.provider)) clearFailedSafety(db, row.provider)
      log(`observer settings saved host=${row.host} provider=${row.provider} enabled=${row.enabled}`)
      return row
    },
    recheck: (provider) => {
      const cleared = clearFailedSafety(db, provider)
      log(`observer recheck provider=${provider} cleared=${cleared}`)
      return cleared
    },
  }
}
