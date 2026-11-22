import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { EmbedError } from '../../vectors/embedder'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_FILES, LOCAL_MODEL_ID } from '../../vectors/local-model'
import type { EmbedWorkerReply, EmbedWorkerRequest } from '../../vectors/local-embed-protocol'
import { type EmbedWorker, localModelPaths, startLocalEmbedder } from '../../vectors/local-embedder'
import { testModelDir } from './local-test-support'

describe('localModelPaths', () => {
  test('a folder missing a file gives the reason', () => {
    const answer = localModelPaths({ embedded: null, devDir: join(import.meta.dir, 'no-such-folder') })
    expect(answer.ok).toBe(false)
    if (!answer.ok) expect(answer.reason).toContain('bun tools/fetch-model.ts')
  })

  test('embedded files win over a checkout folder', () => {
    const embedded = { model: '/$bunfs/m', vocab: '/$bunfs/v', wasm: '/$bunfs/w' }
    expect(localModelPaths({ embedded, devDir: '/nowhere' })).toEqual({ ok: true, paths: embedded })
  })
})

test('a worker that cannot load the files answers the reason', async () => {
  const started = await startLocalEmbedder({ paths: { model: '/nowhere/m', vocab: '/nowhere/v', wasm: '/nowhere/w' } })
  expect(started.ok).toBe(false)
})

/** A worker that loads at once and then does only what the test tells it: it can exit with no error event. */
function quietWorker(): { worker: EmbedWorker; exit: () => void; posted: EmbedWorkerRequest[] } {
  const target = new EventTarget()
  const posted: EmbedWorkerRequest[] = []
  const worker: EmbedWorker = {
    onmessage: null,
    onerror: null,
    postMessage: (message: EmbedWorkerRequest) => {
      posted.push(message)
      if (message.kind === 'start') queueMicrotask(() => worker.onmessage?.({ data: { kind: 'started', ok: true, ms: 1 } } as MessageEvent<EmbedWorkerReply>))
    },
    terminate: () => {},
    addEventListener: (type: string, listener: () => void) => target.addEventListener(type, listener),
  }
  return { worker, exit: () => target.dispatchEvent(new Event('close')), posted }
}

const NO_PATHS = { model: '/nowhere/m', vocab: '/nowhere/v', wasm: '/nowhere/w' }

test('a worker that exits with no error event fails the embed in flight and every later one, instead of leaving them waiting', async () => {
  const quiet = quietWorker()
  const started = await startLocalEmbedder({ paths: NO_PATHS, createWorker: () => quiet.worker })
  expect(started.ok).toBe(true)
  if (!started.ok) return
  const inFlight = started.embedder.embed(['one batch'], undefined, 'index')
  expect(quiet.posted.at(-1)).toMatchObject({ kind: 'embed', texts: ['one batch'] })

  quiet.exit()

  await expect(inFlight).rejects.toMatchObject({ kind: 'unavailable', message: 'the local embed worker exited' })
  await expect(started.embedder.embed(['the next batch'])).rejects.toBeInstanceOf(EmbedError)
})

test('a worker that exits while the model loads answers the start instead of waiting out the load timeout', async () => {
  const quiet = quietWorker()
  const silent: EmbedWorker = { ...quiet.worker, postMessage: () => queueMicrotask(quiet.exit) }
  const started = await startLocalEmbedder({ paths: NO_PATHS, createWorker: () => silent, startTimeoutMs: 60_000 })
  expect(started).toEqual({ ok: false, reason: 'the local embed worker stopped while starting' })
})

const modelDir = testModelDir()

describe.skipIf(modelDir === null)('the real worker', () => {
  const paths = { model: join(modelDir!, LOCAL_MODEL_FILES.model.name), vocab: join(modelDir!, LOCAL_MODEL_FILES.vocab.name), wasm: join(modelDir!, LOCAL_MODEL_FILES.wasm.name) }

  test('embeds in its own thread', async () => {
    const started = await startLocalEmbedder({ paths })
    if (!started.ok) throw new Error(started.reason)
    const { embedder } = started
    expect(embedder.model).toBe(LOCAL_MODEL_ID)
    expect(embedder.dims).toBe(LOCAL_MODEL_DIMS)
    const vectors = await embedder.embed(['one text', 'another'])
    expect(vectors.map((v) => v.length)).toEqual([LOCAL_MODEL_DIMS, LOCAL_MODEL_DIMS])
    await embedder.close()
  }, 60_000)

  test('an aborted call rejects as a timeout', async () => {
    const started = await startLocalEmbedder({ paths })
    if (!started.ok) throw new Error(started.reason)
    const controller = new AbortController()
    const call = started.embedder.embed(Array.from({ length: 50 }, (_, i) => `text number ${i}`), controller.signal)
    controller.abort()
    const error = await call.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(EmbedError)
    expect((error as EmbedError).kind).toBe('timeout')
    await started.embedder.close()
  }, 60_000)

  test('an abort during the model load ends the worker at once', async () => {
    const controller = new AbortController()
    const starting = startLocalEmbedder({ paths, signal: controller.signal })
    const at = performance.now()
    controller.abort()
    expect(await starting).toEqual({ ok: false, reason: 'the local model load was stopped' })
    expect(performance.now() - at).toBeLessThan(100)
  }, 60_000)

  test('after close a call fails as unavailable', async () => {
    const started = await startLocalEmbedder({ paths })
    if (!started.ok) throw new Error(started.reason)
    await started.embedder.close()
    const error = await started.embedder.embed(['x']).catch((caught: unknown) => caught)
    expect((error as EmbedError).kind).toBe('unavailable')
  }, 60_000)
})
