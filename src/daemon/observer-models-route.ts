// GET /observer/models?provider=<codex-cli|opencode-cli>: the model names the
// installed CLI reports, for the dashboard's model list. The runner is built
// with a placeholder model because listModels never reads it. Answers are the
// names or the ObserverError class only; CLI output, paths and env values stay
// inside the runner. Good answers are cached for ten minutes per provider, and
// callers for one provider share a single in-flight listing, so a page full of forms starts one process.

import type { CliObserverRunner } from '../observer/runners/cli-core'
import { CLI_LOGIN_PROVIDERS, type CliLoginProvider, type ObserverSettings, toObserverError } from '../observer/types'
import type { RouteAnswer } from './data-routes'
import { MAX_MODEL_CHARS, isCliLoginProvider } from './settings-route'

const CACHE_MS = 10 * 60_000
const PLACEHOLDER_MODEL = '-'
const MAX_LISTED_MODELS = 200

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
  const inFlight = new Map<CliLoginProvider, Promise<ObserverModelsAnswer>>()

  const list = async (provider: CliLoginProvider, build: (settings: ObserverSettings) => CliObserverRunner): Promise<ObserverModelsAnswer> => {
    try {
      const listed = await build({ provider, model: PLACEHOLDER_MODEL, credentialRef: null, enabled: true, source: 'host' }).listModels()
      const models = listed.filter((name) => name.length <= MAX_MODEL_CHARS).slice(0, MAX_LISTED_MODELS)
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
    const shared = inFlight.get(provider)
    if (shared !== undefined) return { status: 200, body: await shared }
    const started = list(provider, cliRunnerFor).then((answer) => {
      log(`observer models provider=${provider} result=${answer.ok ? 'ok' : answer.errorClass}`)
      return answer
    }).finally(() => inFlight.delete(provider))
    inFlight.set(provider, started)
    return { status: 200, body: await started }
  }
}
