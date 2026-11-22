import { afterEach, beforeEach, expect, test } from 'bun:test'
import { T0, type TempStore, openTempStore } from '../../../resources/tests/observer/test-support'
import { readEmbeddingSettings, writeEmbeddingSettings } from '../../../resources/vectors/embedding-settings'
import { embeddingSettingsRoute } from '../../daemon/embedding-route'

let temp: TempStore
let applied: number
beforeEach(() => {
  temp = openTempStore('kinfold-embedding-route-')
  applied = 0
  writeEmbeddingSettings(temp.store.db, { provider: 'local', llmUrl: null, llmModel: null, llmDims: null }, T0)
})
afterEach(() => temp.cleanup())

const STATUS = { active: null, building: null, lastError: null }

function route(probe: () => Promise<{ ok: true; dims: number } | { ok: false; reason: string }> = async () => ({ ok: true, dims: 768 })) {
  return embeddingSettingsRoute({ db: temp.store.db, status: () => STATUS, probe, now: () => T0, apply: () => { applied += 1 } })
}
const body = (value: unknown) => async () => ({ ok: true as const, value })

test('GET answers the saved settings and the space status', async () => {
  expect(await route()('GET', body(null))).toEqual({ status: 200, body: { settings: { provider: 'local', llmUrl: null, llmModel: null, llmDims: null }, ...STATUS } })
})

test('PUT saves a new provider and applies it', async () => {
  const answer = await route()('PUT', body({ provider: 'openrouter' }))
  expect(answer.status).toBe(200)
  expect(readEmbeddingSettings(temp.store.db)?.provider).toBe('openrouter')
  expect(applied).toBe(1)
})

test('PUT of the same settings saves without restarting anything', async () => {
  await route()('PUT', body({ provider: 'local' }))
  expect(applied).toBe(0)
})

test('a local LLM is probed for its vector length before it is saved', async () => {
  const answer = await route()('PUT', body({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic' }))
  expect(answer.status).toBe(200)
  expect(readEmbeddingSettings(temp.store.db)).toEqual({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic', llmDims: 768 })
})

test('a local LLM that does not answer is refused and nothing is saved', async () => {
  const answer = await route(async () => ({ ok: false, reason: 'the local LLM did not answer' }))('PUT', body({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:1/v1', llmModel: 'nomic' }))
  expect(answer).toEqual({ status: 400, body: { error: 'the local LLM did not answer' } })
  expect(readEmbeddingSettings(temp.store.db)?.provider).toBe('local')
  expect(applied).toBe(0)
})

test('an address off this machine is refused before any probe', async () => {
  let probed = false
  const answer = await route(async () => {
    probed = true
    return { ok: true, dims: 3 }
  })('PUT', body({ provider: 'local-llm', llmUrl: 'http://192.168.0.9:11434', llmModel: 'nomic' }))
  expect(answer.status).toBe(400)
  expect(probed).toBe(false)
})

test('other methods are refused', async () => {
  expect((await route()('DELETE', body(null))).status).toBe(405)
})

test('a local LLM is probed even when the body names a length, and a wrong length is refused', async () => {
  let probes = 0
  const answer = await route(async () => {
    probes += 1
    return { ok: true, dims: 768 }
  })('PUT', body({ provider: 'local-llm', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: 'nomic', llmDims: 512 }))
  expect(probes).toBe(1)
  expect(answer).toEqual({ status: 400, body: { error: 'the local LLM answers vectors of 768 numbers, not 512' } })
})
