// GET and PUT /observer/settings (the daemon is the single writer).
// The installer saves each host's observer choice here, and the dashboard will
// reuse the same routes. PUT checks everything resolveObserverSettings would
// later refuse, so a stored row never fails a batch as config_invalid. Errors
// name the field, never echo its value.

import type { Parsed } from '../context/types'
import type { ProbeFailure } from '../observer/safety-gate'
import { KNOWN_HOSTS, isRecord } from '../contract/event'
import { providerTakesKey, resolveObserverSettings } from '../observer/settings'
import { CLI_LOGIN_PROVIDERS, type CliLoginProvider, OBSERVER_PROVIDERS, type ObserverProvider, type ObserverSettings, toObserverError } from '../observer/types'
import { assertCredentialRef, isSystemCredentialRef } from '../secrets/credentials'
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
  effective: EffectiveSettings[]
}

export interface ObserverSettingsHandlers {
  list: () => ObserverSettingsView
  put: (input: ObserverSettingsInput) => ObserverSettingsRow
  /** Forgets a CLI provider's failed safety rows so its next batch tests again; returns the count. */
  recheck: (provider: CliLoginProvider) => number
}

export function isCliLoginProvider(provider: unknown): provider is CliLoginProvider {
  return (CLI_LOGIN_PROVIDERS as readonly unknown[]).includes(provider)
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
  const credentialRef = providerTakesKey(provider as ObserverProvider) ? ref.value : null
  return { ok: true, value: { host, provider: provider as ObserverProvider, model: model.trim(), credentialRef, enabled: enabled ?? true } }
}

function effectiveFor(db: Database, host: string): EffectiveSettings {
  try {
    return { host, settings: resolveObserverSettings(db, host) }
  } catch (error: unknown) {
    return { host, error: toObserverError(error).errorClass }
  }
}

export function observerSettingsView(db: Database, probe: readonly ProbeFailure[] = []): ObserverSettingsView {
  const rows = listObserverSettings(db)
  const hosts = [...new Set([...REPORTED_HOSTS, ...rows.map((row) => row.host).filter((host) => host !== '*')])]
  const safety = listSafety(db).map(({ binaryPath: _binaryPath, ...rest }) => rest)
  return { rows, safety, probe: probe.map(({ provider, errorClass }) => ({ provider, errorClass })), effective: hosts.map((host) => effectiveFor(db, host)) }
}

/** Logs the host and provider only. `probeFailures` is the safety gate's in-memory list, when the daemon observes. */
export function settingsHandlers(db: Database, now: () => number, log: (line: string) => void, probeFailures: () => readonly ProbeFailure[] = () => []): ObserverSettingsHandlers {
  return {
    list: () => observerSettingsView(db, probeFailures()),
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
