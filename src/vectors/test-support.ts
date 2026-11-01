// A deterministic embedder for tests: each word adds to one of DIMS buckets,
// so texts that share words point the same way. It never touches the network.

import type { Embedder } from './embedder'

export const FAKE_DIMS = 8

export function fakeVector(text: string): Float32Array {
  const vector = new Float32Array(FAKE_DIMS)
  for (const word of text.toLowerCase().split(/\W+/).filter((w) => w !== '')) {
    const bucket = [...word].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 1_000_003, 7) % FAKE_DIMS
    vector[bucket] = (vector[bucket] ?? 0) + 1
  }
  return vector
}

export interface FakeEmbedder extends Embedder {
  /** Every batch the embedder was asked for, in order. */
  calls: string[][]
  /** Throw this on the next calls, one per call; empty means succeed. */
  failures: Error[]
}

export function fakeEmbedder(model = 'fake-embed'): FakeEmbedder {
  const calls: string[][] = []
  const failures: Error[] = []
  return {
    model,
    dims: FAKE_DIMS,
    calls,
    failures,
    embed: async (texts) => {
      calls.push([...texts])
      const failure = failures.shift()
      if (failure !== undefined) throw failure
      return texts.map(fakeVector)
    },
  }
}
