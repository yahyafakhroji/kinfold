import { expect, test } from 'bun:test'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_ID } from '../../vectors/local-model'
import { runEmbedCheck } from '../../vectors/embed-check'
import type { LocalEmbedder } from '../../vectors/local-embedder'

const PATHS = { ok: true as const, paths: { model: 'm', vocab: 'v', wasm: 'w' } }

function embedderFrom(vectors: number[][]): LocalEmbedder {
  return {
    model: LOCAL_MODEL_ID,
    dims: LOCAL_MODEL_DIMS,
    embed: async () => vectors.map((v) => Float32Array.from({ length: LOCAL_MODEL_DIMS }, (_, i) => v[i] ?? 0)),
    close: async () => {},
  }
}

test('passes when the related pair is nearer than the unrelated one', async () => {
  const lines: string[] = []
  const code = await runEmbedCheck({ paths: () => PATHS, start: async () => ({ ok: true, embedder: embedderFrom([[1, 0], [0.9, 0.1], [0, 1]]), ms: 5 }), print: (line) => lines.push(line) })
  expect(code).toBe(0)
  expect(lines.join('\n')).toContain(`embed-check ok model=${LOCAL_MODEL_ID} dims=${LOCAL_MODEL_DIMS}`)
})

test('fails when the vectors do not rank the pair first', async () => {
  const lines: string[] = []
  const code = await runEmbedCheck({ paths: () => PATHS, start: async () => ({ ok: true, embedder: embedderFrom([[1, 0], [0, 1], [1, 0]]), ms: 5 }), print: (line) => lines.push(line) })
  expect(code).toBe(1)
  expect(lines.join('\n')).toContain('embed-check failed')
})

test('fails with the reason when the model cannot load', async () => {
  const lines: string[] = []
  const code = await runEmbedCheck({ paths: () => PATHS, start: async () => ({ ok: false, reason: 'no model' }), print: (line) => lines.push(line) })
  expect(code).toBe(1)
  expect(lines).toEqual(['embed-check failed: no model'])
})
