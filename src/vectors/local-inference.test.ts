import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_FILES } from './local-model'
import { createLocalInference, meanPoolNormalized, verifyModelFiles } from './local-inference'
import { testModelDir } from './local-test-support'

describe('meanPoolNormalized', () => {
  test('averages the token rows and scales to unit length', () => {
    // Two tokens of three dims: mean (2, 0, 0), unit length (1, 0, 0).
    expect(Array.from(meanPoolNormalized(new Float32Array([1, 1, 0, 3, -1, 0]), 2, 3))).toEqual([1, 0, 0])
  })

  test('an all-zero mean stays zero instead of NaN', () => {
    expect(Array.from(meanPoolNormalized(new Float32Array(4), 2, 2))).toEqual([0, 0])
  })
})

describe('verifyModelFiles', () => {
  test('names the file whose hash is wrong', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(verifyModelFiles({ model: bytes, vocab: bytes, wasm: bytes })).toEqual({ ok: false, reason: `${LOCAL_MODEL_FILES.model.name} does not match the pinned sha256` })
  })
})

const modelDir = testModelDir()
const cosine = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i]! * b[i]!
  return dot
}

describe.skipIf(modelDir === null)('the real model', () => {
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(modelDir!, name)))
  const files = { model: read(LOCAL_MODEL_FILES.model.name), vocab: read(LOCAL_MODEL_FILES.vocab.name), wasm: read(LOCAL_MODEL_FILES.wasm.name) }

  test('the fetched files pass the hash check', () => {
    expect(verifyModelFiles(files)).toEqual({ ok: true })
  })

  test('matches the reference vectors', async () => {
    const inference = await createLocalInference(files)
    const fixtures = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'test', 'minilm-reference.json'), 'utf8')) as { text: string; vector: number[] }[]
    for (const fixture of fixtures) {
      const vector = await inference.embed(fixture.text)
      expect(vector).toHaveLength(LOCAL_MODEL_DIMS)
      expect(cosine(vector, fixture.vector)).toBeGreaterThan(0.9999)
    }
  }, 60_000)

  test('a related sentence is nearer than an unrelated one', async () => {
    const inference = await createLocalInference(files)
    const [a, b, c] = await Promise.all(['Kinfold keeps memory local.', 'Memory stays on this machine.', 'Two eggs and a cup of flour.'].map((text) => inference.embed(text)))
    expect(cosine(a!, b!)).toBeGreaterThan(cosine(a!, c!))
  }, 60_000)
})
