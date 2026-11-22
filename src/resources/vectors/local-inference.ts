// all-MiniLM-L6-v2 run by onnxruntime-web's WASM build, one text at a time.
// WASM over a native addon: one file runs on all five targets, and the
// program carries no per-platform library beside sqlite3mc and sqlite-vec.
// One thread, so indexing in the background uses one core at most. The
// sentence vector is sentence-transformers' recipe: the mean of the token
// vectors, scaled to unit length. Text is never logged here.

import { createHash } from 'node:crypto'
import * as ort from 'onnxruntime-web/wasm'
import { LOCAL_MAX_TOKENS, LOCAL_MODEL_DIMS, LOCAL_MODEL_FILES, type LocalModelFile } from './local-model'
import { createWordPiece } from './tokenizer'

export type ModelBytes = Readonly<Record<LocalModelFile, Uint8Array>>

export interface LocalInference {
  embed(text: string): Promise<Float32Array>
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

/** Each file against its pinned hash, before any of them is loaded. */
export function verifyModelFiles(files: ModelBytes): { ok: true } | { ok: false; reason: string } {
  for (const key of ['model', 'vocab', 'wasm'] as const) {
    if (sha256(files[key]) !== LOCAL_MODEL_FILES[key].sha256) return { ok: false, reason: `${LOCAL_MODEL_FILES[key].name} does not match the pinned sha256` }
  }
  return { ok: true }
}

/** hidden holds `tokens` rows of `dims` floats; every token counts, since one text has no padding. */
export function meanPoolNormalized(hidden: Float32Array, tokens: number, dims: number): Float32Array {
  const out = new Float32Array(dims)
  for (let t = 0; t < tokens; t += 1) {
    for (let d = 0; d < dims; d += 1) out[d]! += hidden[t * dims + d]!
  }
  let norm = 0
  for (let d = 0; d < dims; d += 1) {
    out[d]! /= tokens
    norm += out[d]! * out[d]!
  }
  norm = Math.sqrt(norm)
  if (norm > 0) for (let d = 0; d < dims; d += 1) out[d]! /= norm
  return out
}

const int64 = (values: readonly number[]): BigInt64Array => BigInt64Array.from(values, (value) => BigInt(value))

/** Throws when a file fails its hash or the model does not load. */
export async function createLocalInference(files: ModelBytes): Promise<LocalInference> {
  const verified = verifyModelFiles(files)
  if (!verified.ok) throw new Error(verified.reason)
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmBinary = files.wasm
  const session = await ort.InferenceSession.create(files.model)
  const tokenizer = createWordPiece(new TextDecoder().decode(files.vocab), LOCAL_MAX_TOKENS)
  const output = session.outputNames[0]!
  return {
    embed: async (text) => {
      const ids = tokenizer.encode(text)
      const shape = [1, ids.length]
      const feeds = {
        input_ids: new ort.Tensor('int64', int64(ids), shape),
        attention_mask: new ort.Tensor('int64', int64(ids.map(() => 1)), shape),
        token_type_ids: new ort.Tensor('int64', new BigInt64Array(ids.length), shape),
      }
      const result = await session.run(feeds)
      const hidden = result[output]
      if (hidden === undefined || hidden.dims[2] !== LOCAL_MODEL_DIMS) throw new Error('the model answered an unexpected shape')
      const vector = meanPoolNormalized(hidden.data as Float32Array, ids.length, LOCAL_MODEL_DIMS)
      hidden.dispose()
      return vector
    },
  }
}
