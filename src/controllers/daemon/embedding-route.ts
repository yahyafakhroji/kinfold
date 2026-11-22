// GET and PUT /embedding/settings: which embedder makes the vectors, and how
// far each space has come. The dashboard and the installer use it, with the
// cookie or the token. A local LLM is asked for one embedding on every save, to learn its vector length and prove it answers on this machine. A
// saved change takes effect through apply, which restarts the store's core so
// the new embedder and space start cleanly. Errors name the field or the
// failure, never echo a value.

import type { Parsed } from '../../resources/context/types'
import type { Database } from '../../resources/sqlite/types'
import { type EmbeddingSettings, parseEmbeddingSettings, readEmbeddingSettings, writeEmbeddingSettings } from '../../resources/vectors/embedding-settings'
import type { probeLocalLlmDims } from '../../resources/vectors/local-llm-embedder'
import type { SpaceStatus } from '../../resources/vectors/space-manager'
import type { RouteAnswer } from './data-routes'

export interface EmbeddingStatus {
  active: SpaceStatus | null
  building: SpaceStatus | null
  /** The indexer's last failure since its last success. */
  lastError: string | null
}

export interface EmbeddingRouteDeps {
  db: Database
  status: () => EmbeddingStatus
  probe: (options: { url: string; model: string }) => ReturnType<typeof probeLocalLlmDims>
  now: () => number
  /** Starts the saved settings; called only when they changed. */
  apply: () => void
}

export type EmbeddingRoute = (method: string, readBody: () => Promise<Parsed<unknown>>) => Promise<RouteAnswer>

const same = (a: EmbeddingSettings | null, b: EmbeddingSettings): boolean =>
  a !== null && a.provider === b.provider && a.llmUrl === b.llmUrl && a.llmModel === b.llmModel && a.llmDims === b.llmDims

export function embeddingSettingsRoute(deps: EmbeddingRouteDeps): EmbeddingRoute {
  return async (method, readBody) => {
    if (method === 'GET') return { status: 200, body: { settings: readEmbeddingSettings(deps.db), ...deps.status() } }
    if (method !== 'PUT') return { status: 405, body: { error: 'method not allowed' } }
    const body = await readBody()
    const parsed = body.ok ? parseEmbeddingSettings(body.value) : body
    if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
    let settings = parsed.value
    // Always asked: a length in the body proves nothing about the server, and a wrong one fails every batch.
    if (settings.provider === 'local-llm') {
      const probed = await deps.probe({ url: settings.llmUrl!, model: settings.llmModel! })
      if (!probed.ok) return { status: 400, body: { error: probed.reason } }
      if (settings.llmDims !== null && settings.llmDims !== probed.dims) {
        return { status: 400, body: { error: `the local LLM answers vectors of ${probed.dims} numbers, not ${settings.llmDims}` } }
      }
      settings = { ...settings, llmDims: probed.dims }
    }
    const changed = !same(readEmbeddingSettings(deps.db), settings)
    writeEmbeddingSettings(deps.db, settings, deps.now())
    if (changed) deps.apply()
    return { status: 200, body: { saved: settings, restarting: changed } }
  }
}
