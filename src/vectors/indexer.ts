// Background embedding (capture to searchable ≤ 30 s, embeddings
// run in the background, batched). The daemon ticks it on an interval and
// after every observer write. A tick embeds up to maxBatchesPerTick batches,
// newest observations first, one call in flight at a time. A failed call
// backs off (30 s doubling to 10 min) so a bad key or an outage costs one
// call per window, not one per tick; the first success resets it. Writes do
// not need sqlite-vec, so the index fills even before the extension is
// installed, and search is ready the moment it loads. stop() aborts a call in
// flight, so daemon shutdown never waits out the embed timeout (launchd kills
// a job that takes about 20 s). Logs carry counts and the error kind and
// message, never input text.

import type { Database } from '../sqlite/types'
import { embeddingInputs, upsertVectors, vectorCounts } from '../store/vector-store'
import { EmbedError, type Embedder } from './embedder'

export const DEFAULT_EMBED_BATCH = 32
export const DEFAULT_BATCHES_PER_TICK = 8
export const DEFAULT_INDEX_TICK_MS = 10_000
export const BACKOFF_BASE_MS = 30_000
export const BACKOFF_MAX_MS = 600_000

export interface IndexerStatus {
  model: string
  dims: number
  indexed: number
  pending: number
  /** Kind and message of the last failure since the last success; null when the last call worked. */
  lastError: string | null
  /** No call before this time (epoch ms); null when not backing off. */
  retryAt: number | null
}

export interface VectorIndexer {
  /** Starts a pass unless one is running, the indexer is stopped, or it is backing off. Never blocks. */
  tick(): void
  /** Resolves once no pass is running. */
  whenIdle(): Promise<void>
  status(): IndexerStatus
  stop(): void
}

export interface IndexerOptions {
  db: Database
  embedder: Embedder
  batchSize?: number
  maxBatchesPerTick?: number
  now?: () => number
  log: (line: string) => void
  /** After each batch, the ids it embedded: the search worker re-reads them into its vector cache. */
  onWritten?: (ids: readonly number[]) => void
}

export function backoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1))
}

function describeError(error: unknown): string {
  if (error instanceof EmbedError) return `${error.kind}: ${error.message}`
  return error instanceof Error ? error.name : 'unknown error'
}

export function createVectorIndexer(options: IndexerOptions): VectorIndexer {
  const { db, embedder, log } = options
  const now = options.now ?? Date.now
  const batchSize = options.batchSize ?? DEFAULT_EMBED_BATCH
  const maxBatches = options.maxBatchesPerTick ?? DEFAULT_BATCHES_PER_TICK
  let running: Promise<void> | null = null
  let stopped = false
  let failures = 0
  let lastError: string | null = null
  let retryAt: number | null = null
  const abort = new AbortController()
  const space = { model: embedder.model, dims: embedder.dims }

  /** Rows written; 0 ends the pass (queue empty, or every row purged while at the embedder). */
  const runBatch = async (): Promise<number> => {
    const inputs = embeddingInputs(db, space, batchSize)
    if (inputs.length === 0) return 0
    const vectors = await embedder.embed(inputs.map((input) => input.text), abort.signal)
    if (stopped) return 0
    const written = upsertVectors(db, embedder.model, inputs.map((input, index) => ({ id: input.id, contentHash: input.contentHash, text: input.text, vector: vectors[index]! })), now())
    // A row skipped as purged is re-read too; the cache drops what the store no longer has.
    if (written > 0) options.onWritten?.(inputs.map((input) => input.id))
    return written
  }

  const pass = async (): Promise<void> => {
    const startedAt = now()
    let written = 0
    try {
      for (let batch = 0; batch < maxBatches && !stopped; batch += 1) {
        const n = await runBatch()
        if (n === 0) break
        written += n
      }
      failures = 0
      lastError = null
      retryAt = null
      if (written > 0) log(`vectors embedded=${written} model=${embedder.model} ms=${now() - startedAt}`)
    } catch (error: unknown) {
      if (stopped) return
      failures += 1
      lastError = describeError(error)
      retryAt = now() + backoffMs(failures)
      log(`vectors embed failed (${lastError}) after=${written} retry_in_ms=${backoffMs(failures)}`)
    }
  }

  return {
    tick: () => {
      if (stopped || running !== null || (retryAt !== null && now() < retryAt)) return
      running = pass().finally(() => {
        running = null
      })
    },
    whenIdle: async () => {
      while (running !== null) await running
    },
    status: () => ({ ...space, ...vectorCounts(db, space), lastError, retryAt }),
    stop: () => {
      stopped = true
      abort.abort()
    },
  }
}
