// GET /observer/models?provider=<codex-cli|opencode-cli>: the model names the
// installed CLI reports, for the dashboard's model list. The runner is built
// with a placeholder model because listModels never reads it. Answers are the
// names or the ObserverError class only; CLI output, paths and env values stay
// inside the runner. Good answers are cached for ten minutes per provider, and
// one listing runs at a time so a held page cannot start process after process.

import type { CliObserverRunner } from '../observer/runners/cli-core'
import { CLI_LOGIN_PROVIDERS, type CliLoginProvider, type ObserverSettings, toObserverError } from '../observer/types'
import type { RouteAnswer } from './data-routes'
import { isCliLoginProvider } from './settings-route'

const CACHE_MS = 10 * 60_000
const PLACEHOLDER_MODEL = '-'

export type ObserverModelsAnswer = { ok: true; models: string[] } | { ok: false; errorClass: string }

export interface ObserverModelsRoute {
  (method: string, url: URL): Promise<RouteAnswer>
}

export function observerModelsRoute(
  cliRunnerFor: ((settings: ObserverSettings) => CliObserverRunner) | null,
  log: (line: string) => void,
  now: () => number,
): ObserverModelsRoute {
  const cache = new Map<CliLoginProvider, { models: string[]; at: number }>()
  let running = false

  const list = async (provider: CliLoginProvider, build: (settings: ObserverSettings) => CliObserverRunner): Promise<ObserverModelsAnswer> => {
    try {
      const models = await build({ provider, model: PLACEHOLDER_MODEL, credentialRef: null, enabled: true, source: 'host' }).listModels()
      cache.set(provider, { models, at: now() })
      return { ok: true, models }
    } catch (error: unknown) {
      return { ok: false, errorClass: toObserverError(error).errorClass }
    }
  }

  return async (method, url) => {
    if (method !== 'GET') return { status: 405, body: { error: 'method not allowed' } }
    const provider = url.searchParams.get('provider')
    if (!isCliLoginProvider(provider)) return { status: 400, body: { error: `provider must be one of ${CLI_LOGIN_PROVIDERS.join(', ')}` } }
    if (cliRunnerFor === null) return { status: 503, body: { error: 'the observer is off in this daemon' } }
    const cached = cache.get(provider)
    if (cached !== undefined && now() - cached.at < CACHE_MS) return { status: 200, body: { ok: true, models: cached.models } }
    if (running) return { status: 409, body: { error: 'a model listing is already running' } }
    running = true
    try {
      const answer = await list(provider, cliRunnerFor)
      log(`observer models provider=${provider} result=${answer.ok ? 'ok' : answer.errorClass}`)
      return { status: 200, body: answer }
    } finally {
      running = false
    }
  }
}
