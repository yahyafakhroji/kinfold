import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { purge } from '../data-control/purge'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { FAKE_DIMS, fakeVector } from '../vectors/test-support'
import { type EmbeddingInput, MAX_EMBED_CHARS, decodeVector, embeddingInputs, embeddingText, encodeVector, upsertVectors, vectorCounts } from './vector-store'

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-vectors-')
  session = seedSession(temp.store, 'claude-code', 's1')
})
afterEach(() => temp.cleanup())

const seed = (title: string, at: number = T0): number => seedObservation(temp.store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title, at })
const vectorRows = (): number => (temp.store.db.query('SELECT count(*) AS n FROM observation_vectors').get() as { n: number }).n
const space = (model: string) => ({ model, dims: FAKE_DIMS })
const asVectors = (inputs: readonly EmbeddingInput[]) => inputs.map((input) => ({ id: input.id, contentHash: input.contentHash, vector: fakeVector(input.text) }))
const embedAll = (model: string): number => upsertVectors(temp.store.db, model, asVectors(embeddingInputs(temp.store.db, space(model), 100)), T0)

test('a vector survives the float32 round trip byte for byte', () => {
  const vector = Float32Array.from([0.5, -1.25, 3e-8, 0])
  expect(encodeVector(vector).length).toBe(16)
  expect([...decodeVector(encodeVector(vector))]).toEqual([...vector])
})

test('the embedding text is title, narrative and facts, trimmed, capped, and tolerant of bad facts JSON', () => {
  expect(embeddingText({ title: ' Parser fix ', narrative: 'It drops quotes.', facts: '["one", 2, "two"]' })).toBe('Parser fix\nIt drops quotes.\none\ntwo')
  expect(embeddingText({ title: 'T', narrative: '', facts: 'not json' })).toBe('T')
  expect(embeddingText({ title: 'x'.repeat(MAX_EMBED_CHARS + 50), narrative: 'n', facts: '[]' }).length).toBe(MAX_EMBED_CHARS)
})

test('the queue is newest first, empties once embedded, and comes back for a new model', () => {
  const older = seed('older', T0)
  const newer = seed('newer', T0 + 1)
  expect(embeddingInputs(temp.store.db, space('m1'), 10).map((input) => input.id)).toEqual([newer, older])
  expect(vectorCounts(temp.store.db, space('m1'))).toEqual({ indexed: 0, pending: 2 })
  expect(embedAll('m1')).toBe(2)
  expect(embeddingInputs(temp.store.db, space('m1'), 10)).toEqual([])
  expect(vectorCounts(temp.store.db, space('m1'))).toEqual({ indexed: 2, pending: 0 })
  expect(vectorCounts(temp.store.db, space('m2'))).toEqual({ indexed: 0, pending: 2 })
  expect(embedAll('m2')).toBe(2)
  expect(vectorRows()).toBe(2)
  expect(vectorCounts(temp.store.db, space('m1'))).toEqual({ indexed: 0, pending: 2 })
})

test('a vector for an observation purged while it was at the embedder is not written', () => {
  const id = seed('soon gone')
  const inputs = embeddingInputs(temp.store.db, space('m1'), 10)
  temp.store.db.query('DELETE FROM observations WHERE id = ?').run(id)
  expect(upsertVectors(temp.store.db, 'm1', asVectors(inputs), T0)).toBe(0)
  expect(vectorRows()).toBe(0)
})

test('a late vector of a purged text never lands on a new observation that reused its id', () => {
  const purged = seed('PURGED-TEXT')
  const inFlight = embeddingInputs(temp.store.db, space('m1'), 10)
  temp.store.db.query('DELETE FROM observations WHERE id = ?').run(purged)
  const reused = seed('a different, newer observation')
  expect(reused).toBe(purged)
  expect(upsertVectors(temp.store.db, 'm1', asVectors(inFlight), T0)).toBe(0)
  expect(embeddingInputs(temp.store.db, space('m1'), 10).map((input) => input.text)).toEqual(['a different, newer observation\nNARRATIVE-THAT-MUST-NOT-BE-INJECTED'])
})

test('a vector of another length is stale even under the same model', () => {
  seed('one')
  embedAll('m1')
  expect(vectorCounts(temp.store.db, { model: 'm1', dims: FAKE_DIMS * 2 })).toEqual({ indexed: 0, pending: 1 })
})

test('deleting an observation deletes its vector, through a plain delete and through purge', () => {
  const plain = seed('plain delete')
  const purged = seed('purged one')
  embedAll('m1')
  temp.store.db.query('DELETE FROM observations WHERE id = ?').run(plain)
  expect(vectorRows()).toBe(1)
  purge(temp.store.db, { kind: 'observation', id: purged }, { dryRun: false, now: () => T0 })
  expect(vectorRows()).toBe(0)
})

test('the table refuses an embedding whose length does not match its dims', () => {
  const id = seed('bad blob')
  expect(() => temp.store.db.query('INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'm1', FAKE_DIMS, new Uint8Array(3), T0)).toThrow()
})
