import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { upsertVectors } from '../../store/vector-store'
import { DEFAULT_EMBED_DIMS, DEFAULT_EMBED_MODEL } from '../../vectors/embedder'
import {
  ensureEmbeddingSettings, isLoopbackUrl, llmEndpoint, parseEmbeddingSettings, readEmbeddingSettings, spaceForSettings, writeEmbeddingSettings,
} from '../../vectors/embedding-settings'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_ID } from '../../vectors/local-model'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-embed-settings-')
})
afterEach(() => temp.cleanup())

const LOCAL = { provider: 'local' as const, llmUrl: null, llmModel: null, llmDims: null }

function embedOne(model: string): void {
  const session = seedSession(temp.store, 'claude-code', `s-${model}`)
  const id = seedObservation(temp.store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title: 'x', at: T0 })
  const hash = (temp.store.db.query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
  upsertVectors(temp.store.db, model, [{ id, contentHash: hash, vector: new Float32Array(4) }], T0)
}

describe('ensureEmbeddingSettings', () => {
  test('a store with no OpenRouter vectors moves to the local model, even with a key', () => {
    expect(ensureEmbeddingSettings(temp.store.db, T0)).toEqual(LOCAL)
    expect(readEmbeddingSettings(temp.store.db)).toEqual(LOCAL)
  })

  test('a store that already has OpenRouter vectors stays on OpenRouter', () => {
    embedOne(DEFAULT_EMBED_MODEL)
    expect(ensureEmbeddingSettings(temp.store.db, T0).provider).toBe('openrouter')
  })

  test('a saved choice is kept', () => {
    embedOne(DEFAULT_EMBED_MODEL)
    writeEmbeddingSettings(temp.store.db, LOCAL, T0)
    expect(ensureEmbeddingSettings(temp.store.db, T0)).toEqual(LOCAL)
  })
})

describe('spaceForSettings', () => {
  test('each provider and model is its own space', () => {
    expect(spaceForSettings(LOCAL)).toEqual({ model: LOCAL_MODEL_ID, dims: LOCAL_MODEL_DIMS })
    expect(spaceForSettings({ ...LOCAL, provider: 'openrouter' })).toEqual({ model: DEFAULT_EMBED_MODEL, dims: DEFAULT_EMBED_DIMS })
    expect(spaceForSettings({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic-embed-text', llmDims: 768 })).toEqual({ model: 'local-llm/nomic-embed-text', dims: 768 })
  })
})

describe('isLoopbackUrl', () => {
  test('accepts loopback addresses only', () => {
    for (const url of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1/embeddings', 'http://[::1]:8080', 'https://127.0.0.2/v1']) expect(isLoopbackUrl(url)).toBe(true)
    for (const url of ['http://192.168.1.4:11434', 'http://example.com', 'http://127.0.0.1.example.com', 'ftp://127.0.0.1', 'http://user:pw@127.0.0.1:1', 'not a url', 'http://0.0.0.0:11434']) {
      expect(isLoopbackUrl(url)).toBe(false)
    }
  })
})

test('llmEndpoint adds /embeddings once', () => {
  expect(llmEndpoint('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1/embeddings')
  expect(llmEndpoint('http://127.0.0.1:11434/v1/')).toBe('http://127.0.0.1:11434/v1/embeddings')
  expect(llmEndpoint('http://127.0.0.1:11434/v1/embeddings')).toBe('http://127.0.0.1:11434/v1/embeddings')
})

describe('parseEmbeddingSettings', () => {
  test('local and openrouter need nothing else', () => {
    expect(parseEmbeddingSettings({ provider: 'local' })).toEqual({ ok: true, value: LOCAL })
    expect(parseEmbeddingSettings({ provider: 'openrouter' })).toEqual({ ok: true, value: { ...LOCAL, provider: 'openrouter' } })
  })

  test('a local LLM needs a loopback address and a model; dims may come later from a probe', () => {
    expect(parseEmbeddingSettings({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic-embed-text' }))
      .toEqual({ ok: true, value: { provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic-embed-text', llmDims: null } })
    expect(parseEmbeddingSettings({ provider: 'local-llm', llmUrl: 'http://10.0.0.2:11434', llmModel: 'm' })).toEqual({ ok: false, error: 'llmUrl must be an http address on this machine (127.0.0.1, localhost or ::1)' })
    expect(parseEmbeddingSettings({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:1', llmModel: '' })).toEqual({ ok: false, error: 'llmModel must be a non-empty model name' })
    // A model name is written to the daemon log, and so is the address when the server does not answer.
    for (const llmModel of ['m\nforged log line', 'm\u0000', 'm\u001b[2J', 'm\u007f']) {
      expect(parseEmbeddingSettings({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:1', llmModel })).toEqual({ ok: false, error: 'llmModel must be a non-empty model name' })
    }
    for (const llmUrl of ['http://127.0.0.1:1/v1?api_key=abc', 'http://127.0.0.1:1/v1#frag', 'http://localhost:1/?x']) {
      expect(parseEmbeddingSettings({ provider: 'local-llm', llmUrl, llmModel: 'm' })).toEqual({ ok: false, error: 'llmUrl must be an http address on this machine (127.0.0.1, localhost or ::1)' })
    }
    expect(parseEmbeddingSettings({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:1', llmModel: 'm', llmDims: 0 })).toEqual({ ok: false, error: 'llmDims must be an integer from 1 to 8192' })
  })

  test('an unknown provider is refused by name', () => {
    expect(parseEmbeddingSettings({ provider: 'agent' })).toEqual({ ok: false, error: 'provider must be one of local, openrouter, local-llm' })
    expect(parseEmbeddingSettings('x')).toEqual({ ok: false, error: 'body must be a JSON object' })
  })
})
