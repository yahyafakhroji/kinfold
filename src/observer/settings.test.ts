import { afterEach, beforeEach, expect, test } from 'bun:test'
import { credentialRefFor, providerTakesKey, resolveObserverSettings } from './settings'
import { type TempStore, openTempStore } from './test-support'
import { ObserverError } from './types'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-settings-')
})
afterEach(() => temp.cleanup())

function setRow(host: string, provider: string, model: string, enabled = 1): void {
  temp.store.db.query(
    `INSERT INTO observer_settings (host, provider, model, credential_ref, enabled, updated_at) VALUES ($host, $provider, $model, NULL, $enabled, 1)
     ON CONFLICT (host) DO UPDATE SET provider = excluded.provider, model = excluded.model, enabled = excluded.enabled`,
  ).run({ host, provider, model, enabled })
}

test('built-in defaults: claude-code and unknown hosts get Haiku via the CLI, opencode gets OpenRouter Auto', () => {
  const db = temp.store.db
  expect(resolveObserverSettings(db, 'claude-code')).toEqual({ provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true, source: 'built-in' })
  expect(resolveObserverSettings(db, 'opencode')).toEqual({ provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' })
  expect(resolveObserverSettings(db, 'zed')).toMatchObject({ provider: 'claude-cli', model: 'haiku', source: 'built-in' })
})

test('built-in defaults: codex and cursor get OpenRouter Auto like opencode (P1-F)', () => {
  const db = temp.store.db
  for (const host of ['codex', 'cursor']) {
    expect(resolveObserverSettings(db, host)).toEqual({ provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' })
  }
})

test('the * row beats the built-in default, and the host row beats the * row', () => {
  const db = temp.store.db
  setRow('*', 'openrouter', 'some/model')
  expect(resolveObserverSettings(db, 'claude-code')).toMatchObject({ provider: 'openrouter', model: 'some/model', source: 'default-row' })
  setRow('claude-code', 'claude-cli', 'sonnet')
  expect(resolveObserverSettings(db, 'claude-code')).toMatchObject({ provider: 'claude-cli', model: 'sonnet', source: 'host' })
  expect(resolveObserverSettings(db, 'opencode')).toMatchObject({ provider: 'openrouter', model: 'some/model', source: 'default-row' })
})

test('a disabled row is reported as disabled, not replaced by a default', () => {
  setRow('opencode', 'openrouter', 'openrouter/auto', 0)
  expect(resolveObserverSettings(temp.store.db, 'opencode')).toMatchObject({ enabled: false, source: 'host' })
})

test('an unknown provider is a config error, never a silent switch', () => {
  setRow('claude-code', 'gemini-cli', 'flash')
  expect(() => resolveObserverSettings(temp.store.db, 'claude-code')).toThrow(ObserverError)
  expect(() => resolveObserverSettings(temp.store.db, 'claude-code')).toThrow('config_invalid')
})

test('only openrouter takes a key; credentialRefFor is null for every CLI-login provider', () => {
  const base = { model: 'm', credentialRef: null, enabled: true, source: 'host' as const }
  for (const provider of ['claude-cli', 'codex-cli', 'opencode-cli'] as const) {
    expect(providerTakesKey(provider)).toBe(false)
    expect(credentialRefFor({ ...base, provider })).toBeNull()
  }
  expect(providerTakesKey('openrouter')).toBe(true)
  expect(credentialRefFor({ ...base, provider: 'openrouter' })).toBe('openrouter')
})
