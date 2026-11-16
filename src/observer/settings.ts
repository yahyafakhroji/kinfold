// Which observer a session gets: the observer_settings row for
// its host, then the '*' row, then the built-in default for that host. Read on
// every batch, so a dashboard change applies to the next batch without a restart.
// A row naming an unknown provider is an error, never a reason to pick another.

import type { Database } from '../sqlite/types'
import { checkEndpoint } from './endpoint'
import {
  ENDPOINT_PROVIDERS,
  type EndpointProvider,
  HTTP_API_PROVIDERS,
  OBSERVER_PROVIDERS,
  ObserverError,
  type ObserverProvider,
  type ObserverSettings,
} from './types'

export const DEFAULT_HOST_ROW = '*'
export const OPENROUTER_CREDENTIAL_REF = 'openrouter'
/** The key-store entry setup offers an OpenAI-compatible endpoint across the network. */
export const OPENAI_COMPATIBLE_CREDENTIAL_REF = 'openai-compatible'

/**
 * The key-store entry each API provider reads when its row names none. The
 * OpenAI-compatible endpoint has no entry of its own: a local server needs no
 * key, so it reads one only when the row names it.
 */
export const DEFAULT_CREDENTIAL_REFS: Readonly<Partial<Record<ObserverProvider, string>>> = {
  openrouter: OPENROUTER_CREDENTIAL_REF,
  'anthropic-api': 'anthropic',
  'openai-api': 'openai',
  'gemini-api': 'gemini',
  'qwen-api': 'dashscope',
}

/**
 * The model offered first for each provider: the vendor's cheapest fast tier
 * as of 2026-11-16, since the observer only summarises. The
 * OpenAI-compatible endpoint and Goose have none, as their models depend on
 * what the user runs or signed in to.
 */
const DEFAULT_MODELS: Readonly<Partial<Record<ObserverProvider, string>>> = {
  'claude-cli': 'haiku',
  openrouter: 'openrouter/auto',
  'anthropic-api': 'claude-haiku-5-5',
  'openai-api': 'gpt-6-luna',
  'gemini-api': 'gemini-3.5-flash-lite',
  'qwen-api': 'qwen3.8-flash',
}

/**
 * Why a row may not read this key, or null. A key setup stored for one
 * provider never goes to another: the OpenAI-compatible endpoint and Qwen take
 * any address, so a row pairing them with, say, the Anthropic key would send
 * that key to whatever host the row names.
 */
export function credentialRefProblem(provider: ObserverProvider, ref: string): string | null {
  const own = provider === 'openai-compatible' ? OPENAI_COMPATIBLE_CREDENTIAL_REF : DEFAULT_CREDENTIAL_REFS[provider]
  const taken = [...Object.values(DEFAULT_CREDENTIAL_REFS), OPENAI_COMPATIBLE_CREDENTIAL_REF]
  return ref !== own && taken.includes(ref) ? 'names the key of another provider' : null
}

export function defaultModelFor(provider: ObserverProvider): string | null {
  return DEFAULT_MODELS[provider] ?? null
}

export function isEndpointProvider(provider: string): provider is EndpointProvider {
  return (ENDPOINT_PROVIDERS as readonly string[]).includes(provider)
}

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
  endpoint: string | null
}

export function builtInSettings(host: string): ObserverSettings {
  return { ...(BUILT_IN[host] ?? CLAUDE_HAIKU), source: 'built-in' }
}

function readRow(db: Database, host: string): SettingsRow | null {
  return db.query<SettingsRow, { host: string }>(
    'SELECT provider, model, credential_ref AS credentialRef, enabled, endpoint FROM observer_settings WHERE host = $host',
  ).get({ host })
}

function fromRow(row: SettingsRow, source: ObserverSettings['source']): ObserverSettings {
  if (!OBSERVER_PROVIDERS.includes(row.provider as ObserverProvider)) {
    throw new ObserverError('config_invalid', `unknown observer provider in observer_settings (${source})`)
  }
  if (row.model.trim() === '') throw new ObserverError('config_invalid', `empty observer model in observer_settings (${source})`)
  const provider = row.provider as ObserverProvider
  const refProblem = row.credentialRef === null || !providerTakesKey(provider) ? null : credentialRefProblem(provider, row.credentialRef)
  if (refProblem !== null) throw new ObserverError('config_invalid', `credential_ref ${refProblem} (${source})`)
  const settings: ObserverSettings = { provider, model: row.model, credentialRef: row.credentialRef, enabled: row.enabled !== 0, source }
  if (!isEndpointProvider(provider)) return settings
  if (row.endpoint === null) throw new ObserverError('config_invalid', `${provider} needs an endpoint in observer_settings (${source})`)
  const endpoint = checkEndpoint(provider, row.endpoint)
  if (!endpoint.ok) throw new ObserverError('config_invalid', `${endpoint.error} (${source})`)
  return { ...settings, endpoint: endpoint.value }
}

/** The API providers read a key from the key store; the CLI providers use the user's own login. */
export function providerTakesKey(provider: ObserverProvider): boolean {
  return (HTTP_API_PROVIDERS as readonly string[]).includes(provider)
}

/** The key-store ref a provider reads, as runners/index.ts resolves it; null for a CLI login or a keyless endpoint. */
export function credentialRefFor(settings: ObserverSettings): string | null {
  if (!providerTakesKey(settings.provider)) return null
  return settings.credentialRef ?? DEFAULT_CREDENTIAL_REFS[settings.provider] ?? null
}

/** What decides which observer runs; `source` is left out, so a row equal to the default is no change. Holds no secret. */
export function settingsFingerprint(settings: ObserverSettings): string {
  return JSON.stringify([settings.provider, settings.model, settings.credentialRef, settings.enabled, settings.endpoint ?? null])
}

/** Throws ObserverError('config_invalid') for a row it cannot honour. */
export function resolveObserverSettings(db: Database, host: string): ObserverSettings {
  const hostRow = readRow(db, host)
  if (hostRow !== null) return fromRow(hostRow, 'host')
  const defaultRow = readRow(db, DEFAULT_HOST_ROW)
  if (defaultRow !== null) return fromRow(defaultRow, 'default-row')
  return builtInSettings(host)
}
