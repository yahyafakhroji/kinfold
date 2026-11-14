// Which observer a session gets: the observer_settings row for
// its host, then the '*' row, then the built-in default for that host. Read on
// every batch, so a dashboard change applies to the next batch without a restart.
// A row naming an unknown provider is an error, never a reason to pick another.

import type { Database } from '../sqlite/types'
import { OBSERVER_PROVIDERS, ObserverError, type ObserverProvider, type ObserverSettings } from './types'

export const DEFAULT_HOST_ROW = '*'
export const OPENROUTER_CREDENTIAL_REF = 'openrouter'

type BuiltIn = Omit<ObserverSettings, 'source'>

const CLAUDE_HAIKU: BuiltIn = { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true }
const OPENROUTER_AUTO: BuiltIn = { provider: 'openrouter', model: 'openrouter/auto', credentialRef: OPENROUTER_CREDENTIAL_REF, enabled: true }

// Codex and Cursor default to OpenRouter like OpenCode: neither ships a CLI
// the observer could borrow a login from. Confirmed by the user: no saved row means Auto.
// Every other known agent defaults to OpenRouter too: the observer has no
// provider that borrows their logins. An id outside this table keeps Haiku.
const BUILT_IN: Readonly<Record<string, BuiltIn>> = {
  'claude-code': CLAUDE_HAIKU,
  opencode: OPENROUTER_AUTO,
  codex: OPENROUTER_AUTO,
  cursor: OPENROUTER_AUTO,
  'gemini-cli': OPENROUTER_AUTO,
  'qwen-code': OPENROUTER_AUTO,
  'factory-droid': OPENROUTER_AUTO,
  devin: OPENROUTER_AUTO,
  'kilo-code': OPENROUTER_AUTO,
  cline: OPENROUTER_AUTO,
  copilot: OPENROUTER_AUTO,
  antigravity: OPENROUTER_AUTO,
  junie: OPENROUTER_AUTO,
  kiro: OPENROUTER_AUTO,
  amp: OPENROUTER_AUTO,
  'kimi-code': OPENROUTER_AUTO,
  auggie: OPENROUTER_AUTO,
  goose: OPENROUTER_AUTO,
  crush: OPENROUTER_AUTO,
  zed: OPENROUTER_AUTO,
  continue: OPENROUTER_AUTO,
  warp: OPENROUTER_AUTO,
}

interface SettingsRow {
  provider: string
  model: string
  credentialRef: string | null
  enabled: number
}

export function builtInSettings(host: string): ObserverSettings {
  return { ...(BUILT_IN[host] ?? CLAUDE_HAIKU), source: 'built-in' }
}

function readRow(db: Database, host: string): SettingsRow | null {
  return db.query<SettingsRow, { host: string }>(
    'SELECT provider, model, credential_ref AS credentialRef, enabled FROM observer_settings WHERE host = $host',
  ).get({ host })
}

function fromRow(row: SettingsRow, source: ObserverSettings['source']): ObserverSettings {
  if (!OBSERVER_PROVIDERS.includes(row.provider as ObserverProvider)) {
    throw new ObserverError('config_invalid', `unknown observer provider in observer_settings (${source})`)
  }
  if (row.model.trim() === '') throw new ObserverError('config_invalid', `empty observer model in observer_settings (${source})`)
  return {
    provider: row.provider as ObserverProvider,
    model: row.model,
    credentialRef: row.credentialRef,
    enabled: row.enabled !== 0,
    source,
  }
}

/** Only OpenRouter reads a Keychain key; the CLI providers use the user's own login. */
export function providerTakesKey(provider: ObserverProvider): boolean {
  return provider === 'openrouter'
}

/** The keychain ref a provider reads, as runners/index.ts resolves it; null for providers that use a CLI login. */
export function credentialRefFor(settings: ObserverSettings): string | null {
  return providerTakesKey(settings.provider) ? (settings.credentialRef ?? OPENROUTER_CREDENTIAL_REF) : null
}

/** What decides which observer runs; `source` is left out, so a row equal to the default is no change. Holds no secret. */
export function settingsFingerprint(settings: ObserverSettings): string {
  return JSON.stringify([settings.provider, settings.model, settings.credentialRef, settings.enabled])
}

/** Throws ObserverError('config_invalid') for a row it cannot honour. */
export function resolveObserverSettings(db: Database, host: string): ObserverSettings {
  const hostRow = readRow(db, host)
  if (hostRow !== null) return fromRow(hostRow, 'host')
  const defaultRow = readRow(db, DEFAULT_HOST_ROW)
  if (defaultRow !== null) return fromRow(defaultRow, 'default-row')
  return builtInSettings(host)
}
