// The bundled model as an Embedder. The model runs in its own worker
// (local-embed-worker.ts) so the daemon's thread stays free. Inside a release
// program the files are the ones embedded in it; in a checkout they come from
// .cache/embed-model (bun tools/fetch-model.ts). Nothing is downloaded at run
// time. A worker that stops fails every call as unavailable, and the indexer's
// backoff and the FTS fallback take over.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { embedded } from '../../system/runtime/embedded.generated'
import { isCompiledProgram } from '../../system/runtime/program'
import { EmbedError, type Embedder } from './embedder'
import type { EmbedWorkerReply, EmbedWorkerRequest, ModelPaths } from './local-embed-protocol'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_FILES, LOCAL_MODEL_ID } from './local-model'

/** The worker inside a compiled program, named by its path from src/ (see COMPILED_WORKER_PATH). */
export const COMPILED_EMBED_WORKER_PATH = './resources/vectors/local-embed-worker.ts'
export const EMBED_START_TIMEOUT_MS = 30_000
const DEV_MODEL_DIR = join(import.meta.dir, '..', '..', '..', '.cache', 'embed-model')

export interface LocalEmbedder extends Embedder {
  close(): Promise<void>
}

export type ModelPathsAnswer = { ok: true; paths: ModelPaths } | { ok: false; reason: string }

export function localModelPaths(source: { embedded: ModelPaths | null; devDir: string } = { embedded: embedded?.localModel ?? null, devDir: DEV_MODEL_DIR }): ModelPathsAnswer {
  if (source.embedded !== null) return { ok: true, paths: source.embedded }
  const paths = { model: join(source.devDir, LOCAL_MODEL_FILES.model.name), vocab: join(source.devDir, LOCAL_MODEL_FILES.vocab.name), wasm: join(source.devDir, LOCAL_MODEL_FILES.wasm.name) }
  if (!Object.values(paths).every((path) => existsSync(path))) return { ok: false, reason: 'the local model is not in this checkout; run bun tools/fetch-model.ts' }
  return { ok: true, paths }
}

function workerUrl(): string {
  return isCompiledProgram() ? COMPILED_EMBED_WORKER_PATH : new URL('./local-embed-worker.ts', import.meta.url).href
}

interface Pending {
  resolve: (vectors: Float32Array[]) => void
  reject: (error: Error) => void
}

/** What the embedder uses of its worker. */
export interface EmbedWorker {
  onmessage: ((event: MessageEvent<EmbedWorkerReply>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage(message: EmbedWorkerRequest): void
  terminate(): void
  addEventListener(type: 'close', listener: () => void): void
}

export interface LocalEmbedderOptions {
  paths: ModelPaths
  startTimeoutMs?: number
  /** Ends a load in progress: a core that stops must not wait for the model to finish loading. */
  signal?: AbortSignal
  /** The worker to run the model in; tests pass a stand-in. */
  createWorker?: () => EmbedWorker
}

export async function startLocalEmbedder(options: LocalEmbedderOptions): Promise<{ ok: true; embedder: LocalEmbedder; ms: number } | { ok: false; reason: string }> {
  const worker: EmbedWorker = options.createWorker?.() ?? (new Worker(workerUrl()) as EmbedWorker)
  const pending = new Map<number, Pending>()
  let stopped: string | null = null
  let nextId = 1
  let onStart: ((reply: EmbedWorkerReply) => void) | null = null

  const stop = (reason: string): void => {
    stopped ??= reason
    for (const entry of pending.values()) entry.reject(new EmbedError('unavailable', stopped))
    pending.clear()
  }
  worker.onmessage = (event: MessageEvent<EmbedWorkerReply>) => {
    const reply = event.data
    if (reply.kind === 'started') {
      onStart?.(reply)
      return
    }
    const entry = pending.get(reply.id)
    pending.delete(reply.id)
    if (reply.kind === 'vectors') entry?.resolve(reply.vectors)
    else entry?.reject(new EmbedError('bad_response', `the local model failed (${reply.reason})`))
  }
  worker.onerror = (event: ErrorEvent) => {
    stop(`the local embed worker stopped (${event.message.slice(0, 120)})`)
    onStart?.({ kind: 'started', ok: false, reason: 'the local embed worker stopped while starting' })
  }
  // An exit with no error event would otherwise leave every embed in flight, and the indexer's pass with it, waiting forever.
  worker.addEventListener('close', () => {
    stop('the local embed worker exited')
    onStart?.({ kind: 'started', ok: false, reason: 'the local embed worker stopped while starting' })
  })

  const started = await new Promise<EmbedWorkerReply>((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'started', ok: false, reason: 'the local model did not load in time' }), options.startTimeoutMs ?? EMBED_START_TIMEOUT_MS)
    const onAbort = (): void => onStart?.({ kind: 'started', ok: false, reason: 'the local model load was stopped' })
    onStart = (reply) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      onStart = null
      resolve(reply)
    }
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    worker.postMessage({ kind: 'start', paths: options.paths } satisfies EmbedWorkerRequest)
  })
  if (started.kind !== 'started' || !started.ok) {
    worker.terminate()
    return { ok: false, reason: started.kind === 'started' && !started.ok ? started.reason : 'the local model did not load' }
  }

  const embed: Embedder['embed'] = (texts, signal, purpose = 'index') => {
    if (stopped !== null) return Promise.reject(new EmbedError('unavailable', stopped))
    if (texts.length === 0) return Promise.resolve([])
    if (signal?.aborted === true) return Promise.reject(new EmbedError('timeout', 'the embed was cut short'))
    const id = nextId++
    return new Promise<Float32Array[]>((resolve, reject) => {
      const onAbort = (): void => {
        if (!pending.delete(id)) return
        worker.postMessage({ kind: 'cancel', id } satisfies EmbedWorkerRequest)
        reject(new EmbedError('timeout', 'the embed was cut short'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const done = (): void => signal?.removeEventListener('abort', onAbort)
      pending.set(id, { resolve: (vectors) => (done(), resolve(vectors)), reject: (error) => (done(), reject(error)) })
      worker.postMessage({ kind: 'embed', id, texts: [...texts], purpose } satisfies EmbedWorkerRequest)
    })
  }

  return {
    ok: true,
    ms: started.ms,
    embedder: {
      model: LOCAL_MODEL_ID,
      dims: LOCAL_MODEL_DIMS,
      embed,
      close: async () => {
        stop('the local embed worker was closed')
        worker.terminate()
      },
    },
  }
}
