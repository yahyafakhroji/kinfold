import { afterEach, beforeEach, expect, test } from 'bun:test'
import { T0, type TempStore, openTempStore } from '../observer/test-support'
import { startActive } from '../../store/vector-spaces'
import { DEFAULT_EMBED_DIMS, DEFAULT_EMBED_MODEL, EmbedError } from '../../vectors/embedder'
import { embeddersFor } from '../../vectors/embedders'
import { writeEmbeddingSettings } from '../../vectors/embedding-settings'
import type { LocalEmbedder } from '../../vectors/local-embedder'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_ID } from '../../vectors/local-model'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-embedders-')
})
afterEach(() => temp.cleanup())

function fakeLocal(): { started: number; closed: number; start: () => Promise<{ ok: true; embedder: LocalEmbedder; ms: number }> } {
  const counts = { started: 0, closed: 0 }
  return Object.assign(counts, {
    start: async () => {
      counts.started += 1
      return { ok: true as const, ms: 1, embedder: { model: LOCAL_MODEL_ID, dims: LOCAL_MODEL_DIMS, embed: async (texts: readonly string[]) => texts.map(() => new Float32Array(LOCAL_MODEL_DIMS)), close: async () => { counts.closed += 1 } } }
    },
  })
}

test('a fresh store runs the local model, started once, and closes it', async () => {
  const local = fakeLocal()
  const set = embeddersFor(temp.store.db, { openRouterKey: () => 'sk-test', startLocal: local.start }, T0)
  expect(set.target?.model).toBe(LOCAL_MODEL_ID)
  expect(set.others).toEqual([])
  expect(await set.target!.embed(['a'])).toHaveLength(1)
  await set.close?.()
  expect([local.started, local.closed]).toEqual([1, 1])
})

test('openrouter without a key has no target and says why', () => {
  writeEmbeddingSettings(temp.store.db, { provider: 'openrouter', llmUrl: null, llmModel: null, llmDims: null }, T0)
  const set = embeddersFor(temp.store.db, { openRouterKey: () => null, startLocal: fakeLocal().start }, T0)
  expect(set.target).toBeNull()
  expect(set.reason).toContain('OpenRouter key')
})

test('switching away from OpenRouter stops sending queries there, even while the new space builds', () => {
  startActive(temp.store.db, { model: DEFAULT_EMBED_MODEL, dims: DEFAULT_EMBED_DIMS }, T0)
  writeEmbeddingSettings(temp.store.db, { provider: 'local', llmUrl: null, llmModel: null, llmDims: null }, T0)
  const set = embeddersFor(temp.store.db, { openRouterKey: () => 'sk-test', startLocal: fakeLocal().start }, T0)
  expect(set.target?.model).toBe(LOCAL_MODEL_ID)
  expect(set.others).toEqual([])
})

test('a stored local LLM address off this machine fails semantic search only', () => {
  temp.store.db.run("INSERT INTO embedding_settings (id, provider, llm_url, llm_model, llm_dims, updated_at) VALUES (1, 'local-llm', 'http://10.0.0.1:1', 'm', 3, 0)")
  const set = embeddersFor(temp.store.db, { openRouterKey: () => null, startLocal: fakeLocal().start }, T0)
  expect(set.target).toBeNull()
  expect(set.reason).toContain('loopback')
})

test('while switching from local to a local LLM, the local model stays for search', () => {
  startActive(temp.store.db, { model: LOCAL_MODEL_ID, dims: LOCAL_MODEL_DIMS }, T0)
  writeEmbeddingSettings(temp.store.db, { provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic', llmDims: 768 }, T0)
  const set = embeddersFor(temp.store.db, { openRouterKey: () => null, startLocal: fakeLocal().start }, T0)
  expect(set.target).toMatchObject({ model: 'local-llm/nomic', dims: 768 })
  expect(set.others.map((other) => other.model)).toEqual([LOCAL_MODEL_ID])
})

test('a local LLM setting with no length has no target', () => {
  writeEmbeddingSettings(temp.store.db, { provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic', llmDims: null }, T0)
  const set = embeddersFor(temp.store.db, { openRouterKey: () => null, startLocal: fakeLocal().start }, T0)
  expect(set.target).toBeNull()
  expect(set.reason).toContain('vector length')
})

test('a local model that cannot load fails each call as unavailable with the reason', async () => {
  const set = embeddersFor(temp.store.db, { openRouterKey: () => null, startLocal: async () => ({ ok: false, reason: 'no model here' }) }, T0)
  const error = (await set.target!.embed(['a']).catch((caught: unknown) => caught)) as EmbedError
  expect(error.kind).toBe('unavailable')
  expect(error.message).toBe('no model here')
})
