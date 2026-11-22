import { afterEach, beforeEach, expect, test } from 'bun:test'
import { credentialRefFor, defaultModelFor, providerTakesKey, resolveObserverSettings } from './settings'
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
  expect(resolveObserverSettings(db, 'not-a-known-agent')).toMatchObject({ provider: 'claude-cli', model: 'haiku', source: 'built-in' })
})

test('built-in defaults: codex and cursor get OpenRouter Auto like opencode', () => {
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

function setEndpointRow(host: string, provider: string, model: string, endpoint: string | null, credentialRef: string | null = null): void {
  temp.store.db.query(
    `INSERT INTO observer_settings (host, provider, model, credential_ref, enabled, updated_at, endpoint) VALUES ($host, $provider, $model, $credentialRef, 1, 1, $endpoint)`,
  ).run({ host, provider, model, endpoint, credentialRef })
}

test('every API provider takes a key under its own ref; the OpenAI-compatible endpoint takes one only when the row names it', () => {
  const base = { model: 'm', credentialRef: null, enabled: true, source: 'host' as const }
  const refs = { 'anthropic-api': 'anthropic', 'openai-api': 'openai', 'gemini-api': 'gemini', 'qwen-api': 'dashscope' } as const
  for (const [provider, ref] of Object.entries(refs) as [keyof typeof refs, string][]) {
    expect(providerTakesKey(provider)).toBe(true)
    expect(credentialRefFor({ ...base, provider })).toBe(ref)
    expect(credentialRefFor({ ...base, provider, credentialRef: 'mine' })).toBe('mine')
  }
  expect(providerTakesKey('openai-compatible')).toBe(true)
  expect(credentialRefFor({ ...base, provider: 'openai-compatible' })).toBeNull()
  expect(credentialRefFor({ ...base, provider: 'openai-compatible', credentialRef: 'groq' })).toBe('groq')
  expect(providerTakesKey('goose-cli')).toBe(false)
  expect(credentialRefFor({ ...base, provider: 'goose-cli' })).toBeNull()
})

test('the default model of each new provider is a cheap fast one; the open-ended ones have none', () => {
  expect(defaultModelFor('anthropic-api')).toBe('claude-haiku-5-5')
  expect(defaultModelFor('openai-api')).toBe('gpt-6-luna')
  expect(defaultModelFor('gemini-api')).toBe('gemini-3.5-flash-lite')
  expect(defaultModelFor('qwen-api')).toBe('qwen3.8-flash')
  expect(defaultModelFor('openrouter')).toBe('openrouter/auto')
  expect(defaultModelFor('openai-compatible')).toBeNull()
  expect(defaultModelFor('goose-cli')).toBeNull()
})

test('an endpoint row resolves with its endpoint; providers without one never carry it', () => {
  setEndpointRow('codex', 'openai-compatible', 'llama3.2', 'http://127.0.0.1:11434/v1')
  expect(resolveObserverSettings(temp.store.db, 'codex')).toEqual({ provider: 'openai-compatible', model: 'llama3.2', credentialRef: null, enabled: true, source: 'host', endpoint: 'http://127.0.0.1:11434/v1' })
  setEndpointRow('cursor', 'anthropic-api', 'claude-haiku-5-5', 'https://example.com/v1', 'anthropic')
  expect(resolveObserverSettings(temp.store.db, 'cursor')).toEqual({ provider: 'anthropic-api', model: 'claude-haiku-5-5', credentialRef: 'anthropic', enabled: true, source: 'host' })
})

test('an endpoint provider with no endpoint, or one the rules refuse, is a config error', () => {
  setEndpointRow('codex', 'openai-compatible', 'm', null)
  expect(() => resolveObserverSettings(temp.store.db, 'codex')).toThrow('config_invalid: openai-compatible needs an endpoint')
  setEndpointRow('cursor', 'openai-compatible', 'm', 'http://example.com/v1')
  expect(() => resolveObserverSettings(temp.store.db, 'cursor')).toThrow('config_invalid')
  setEndpointRow('amp', 'qwen-api', 'qwen3.8-flash', 'https://api.example.com/v1', 'dashscope')
  expect(() => resolveObserverSettings(temp.store.db, 'amp')).toThrow('config_invalid')
})

test('a row whose key belongs to another provider is a config error, so a stored key never reaches another host', () => {
  setEndpointRow('codex', 'openai-compatible', 'm', 'https://evil.example/v1', 'anthropic')
  expect(() => resolveObserverSettings(temp.store.db, 'codex')).toThrow('config_invalid: credential_ref names the key of another provider')
})
