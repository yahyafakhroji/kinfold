import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { vectorCounts } from '../store/vector-store'
import { EmbedError } from './embedder'
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, backoffMs, createVectorIndexer } from './indexer'
import { type FakeEmbedder, fakeEmbedder } from './test-support'

let temp: TempStore
let session: number
let embedder: FakeEmbedder
let clock: number
let logs: string[]
beforeEach(() => {
  temp = openTempStore('sam-indexer-')
  session = seedSession(temp.store, 'claude-code', 's1')
  embedder = fakeEmbedder()
  clock = T0
  logs = []
})
afterEach(() => temp.cleanup())

const seed = (title: string): number => seedObservation(temp.store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title, at: T0 })
const indexer = (batchSize = 2) => createVectorIndexer({ db: temp.store.db, embedder, batchSize, maxBatchesPerTick: 3, now: () => clock, log: (line) => logs.push(line) })

test('backoff doubles from the base and stops at the cap', () => {
  expect([0, 1, 2, 3].map(backoffMs)).toEqual([0, BACKOFF_BASE_MS, 2 * BACKOFF_BASE_MS, 4 * BACKOFF_BASE_MS])
  expect(backoffMs(30)).toBe(BACKOFF_MAX_MS)
})

test('a tick embeds in batches, newest first, up to its batch cap; the next tick finishes', async () => {
  for (const title of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) seed(title)
  const vectors = indexer()
  vectors.tick()
  await vectors.whenIdle()
  expect(embedder.calls.map((batch) => batch.length)).toEqual([2, 2, 2])
  expect(embedder.calls[0]![0]).toStartWith('g')
  expect(vectorCounts(temp.store.db, { model: embedder.model, dims: embedder.dims })).toEqual({ indexed: 6, pending: 1 })
  vectors.tick()
  await vectors.whenIdle()
  expect(vectors.status()).toMatchObject({ indexed: 7, pending: 0, lastError: null, retryAt: null })
  expect(logs.some((line) => line.startsWith('vectors embedded=6'))).toBe(true)
})

test('a failure backs off: no call until retryAt, then success clears it', async () => {
  seed('needs a vector')
  embedder.failures.push(new EmbedError('http_error', 'openrouter answered 503'))
  const vectors = indexer()
  vectors.tick()
  await vectors.whenIdle()
  expect(vectors.status()).toMatchObject({ pending: 1, lastError: 'http_error: openrouter answered 503', retryAt: T0 + BACKOFF_BASE_MS })
  clock += BACKOFF_BASE_MS - 1
  vectors.tick()
  await vectors.whenIdle()
  expect(embedder.calls).toHaveLength(1)
  clock += 1
  vectors.tick()
  await vectors.whenIdle()
  expect(embedder.calls).toHaveLength(2)
  expect(vectors.status()).toMatchObject({ indexed: 1, pending: 0, lastError: null, retryAt: null })
})

test('log lines carry counts and the error, never the text sent to the embedder', async () => {
  seed('SECRET-TITLE-TEXT')
  embedder.failures.push(new EmbedError('timeout', 'request failed (TimeoutError)'))
  const vectors = indexer()
  vectors.tick()
  await vectors.whenIdle()
  clock += BACKOFF_BASE_MS
  vectors.tick()
  await vectors.whenIdle()
  expect(logs).toHaveLength(2)
  expect(logs.join('\n')).not.toContain('SECRET-TITLE-TEXT')
})

test('a stopped indexer starts nothing', async () => {
  seed('x')
  const vectors = indexer()
  vectors.stop()
  vectors.tick()
  await vectors.whenIdle()
  expect(embedder.calls).toHaveLength(0)
})

test('stop aborts an embed in flight, writes nothing, and records no failure', async () => {
  seed('slow')
  let aborted = false
  const slow = { ...embedder, embed: (_texts: readonly string[], signal?: AbortSignal) => new Promise<Float32Array[]>((_resolve, reject) => {
    signal!.addEventListener('abort', () => (aborted = true, reject(new EmbedError('timeout', 'request failed (AbortError)'))))
  }) }
  const vectors = createVectorIndexer({ db: temp.store.db, embedder: slow, now: () => clock, log: (line) => logs.push(line) })
  vectors.tick()
  vectors.stop()
  await vectors.whenIdle()
  expect(aborted).toBe(true)
  expect(vectors.status()).toMatchObject({ indexed: 0, pending: 1, lastError: null, retryAt: null })
  expect(logs).toEqual([])
})
