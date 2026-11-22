// The local model, off the daemon's main thread. Embedding a batch holds a
// core for seconds, and the daemon's thread must keep answering /health and
// hooks. The worker reads the model files from the paths it is given (inside
// the program, or .cache in a checkout), checks their hashes, and embeds one
// text at a time through the queue, queries first. Texts and vectors are never
// logged.

import { createEmbedQueue, type EmbedQueue } from './embed-queue'
import type { EmbedWorkerReply, EmbedWorkerRequest, ModelPaths } from './local-embed-protocol'
import { createLocalInference } from './local-inference'

declare const self: Worker

let queue: EmbedQueue | null = null

async function start(paths: ModelPaths): Promise<EmbedWorkerReply> {
  const startedAt = performance.now()
  try {
    const read = async (path: string): Promise<Uint8Array> => new Uint8Array(await Bun.file(path).arrayBuffer())
    const inference = await createLocalInference({ model: await read(paths.model), vocab: await read(paths.vocab), wasm: await read(paths.wasm) })
    queue = createEmbedQueue(inference)
    return { kind: 'started', ok: true, ms: Math.round(performance.now() - startedAt) }
  } catch (error: unknown) {
    return { kind: 'started', ok: false, reason: error instanceof Error ? error.message.slice(0, 160) : 'the model did not load' }
  }
}

self.onmessage = (event: MessageEvent<EmbedWorkerRequest>) => {
  const message = event.data
  if (message.kind === 'start') {
    void start(message.paths).then((reply) => postMessage(reply))
    return
  }
  if (message.kind === 'cancel') {
    queue?.cancel(message.id)
    return
  }
  if (queue === null) {
    postMessage({ kind: 'failed', id: message.id, reason: 'the model is not loaded' } satisfies EmbedWorkerReply)
    return
  }
  queue.submit(message.texts, message.purpose, message.id).then(
    (vectors) => postMessage({ kind: 'vectors', id: message.id, vectors } satisfies EmbedWorkerReply),
    (error: unknown) => {
      // A cancelled job's caller has already stopped waiting.
      if (error instanceof Error && error.message === 'cancelled') return
      postMessage({ kind: 'failed', id: message.id, reason: error instanceof Error ? error.message.slice(0, 160) : 'the embed failed' } satisfies EmbedWorkerReply)
    },
  )
}
