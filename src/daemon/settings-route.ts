// GET and PUT /observer/settings (decision D7, through the single writer D3).
// The installer saves each host's observer choice here, and the dashboard will
// reuse the same routes. PUT checks everything resolveObserverSettings would
// later refuse, so a stored row never fails a batch as config_invalid. Errors
// name the field, never echo its value.

import type { Parsed } from '../context/types'
import { KNOWN_HOSTS, isRecord } from '../contract/event'
import { resolveObserverSettings } from '../observer/settings'
import { OBSERVER_PROVIDERS, type ObserverProvider, type ObserverSettings, toObserverError } from '../observer/types'
import { assertCredentialRef, isSystemCredentialRef } from '../secrets/credentials'
import type { Database } from '../sqlite/types'
import { type ObserverSettingsInput, type ObserverSettingsRow, listObserverSettings, upsertObserverSettings } from '../store/observer-settings-store'

const HOST_PATTERN = /^(\*|[a-z0-9][a-z0-9._-]{0,63})$/
const MAX_MODEL_CHARS = 200
/**
 * Hosts whose effective setting GET always reports, row or not. Every host the
 * contract knows is listed, so Codex and Cursor can be set before they are installed.
 */
export const REPORTED_HOSTS = KNOWN_HOSTS

export type EffectiveSettings = { host: string } & ({ settings: ObserverSettings } | { error: string })

export interface ObserverSettingsView {
  rows: ObserverSettingsRow[]
  effective: EffectiveSettings[]
}

export interface ObserverSettingsHandlers {
  list: () => ObserverSettingsView
  put: (input: ObserverSettingsInput) => ObserverSettingsRow
}

function parseCredentialRef(value: unknown): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, error: 'credentialRef must be a string or null' }
  try {
    assertCredentialRef(value)
  } catch {
    return { ok: false, error: 'credentialRef must be a short lowercase name' }
  }
  if (isSystemCredentialRef(value)) return { ok: false, error: 'credentialRef names a key SAM keeps for itself' }
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
  const credentialRef = provider === 'claude-cli' ? null : ref.value
  return { ok: true, value: { host, provider: provider as ObserverProvider, model: model.trim(), credentialRef, enabled: enabled ?? true } }
}

function effectiveFor(db: Database, host: string): EffectiveSettings {
  try {
    return { host, settings: resolveObserverSettings(db, host) }
  } catch (error: unknown) {
    return { host, error: toObserverError(error).errorClass }
  }
}

export function observerSettingsView(db: Database): ObserverSettingsView {
  const rows = listObserverSettings(db)
  const hosts = [...new Set([...REPORTED_HOSTS, ...rows.map((row) => row.host).filter((host) => host !== '*')])]
  return { rows, effective: hosts.map((host) => effectiveFor(db, host)) }
}

/** Logs the host and provider only. */
export function settingsHandlers(db: Database, now: () => number, log: (line: string) => void): ObserverSettingsHandlers {
  return {
    list: () => observerSettingsView(db),
    put: (input) => {
      const row = upsertObserverSettings(db, input, now())
      log(`observer settings saved host=${row.host} provider=${row.provider} enabled=${row.enabled}`)
      return row
    },
  }
}
