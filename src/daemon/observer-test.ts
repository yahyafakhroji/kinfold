// POST /observer/test: the dashboard's "test this model" button. The body is
// the same as PUT /observer/settings, so a choice can be tried before it is
// saved. It builds that provider's runner through the daemon's RunnerFactory
// (src/observer/runners) and sends the installer's fixed check prompt, which
// carries no project data. The answer is ok or the ObserverError class only;
// the reply, the detail and any credential stay inside this function. One
// test runs at a time, so a held button cannot queue paid calls.

import type { Parsed } from '../context/types'
import { CHECK_PROMPT } from '../install/observer-choice'
import type { RunnerFactory } from '../observer/runners'
import { toObserverError } from '../observer/types'
import type { ObserverSettingsInput } from '../store/observer-settings-store'
import type { RouteAnswer } from './data-routes'
import { parseSettingsPut } from './settings-route'

export type ObserverTestResult = { ok: true } | { ok: false; errorClass: string }

export interface ObserverTester {
  /** Null when the daemon runs without an observer (tests, ingest-only tools). */
  test: ((input: ObserverSettingsInput) => Promise<ObserverTestResult>) | null
}

export function createObserverTester(runnerFor: RunnerFactory | null, log: (line: string) => void): ObserverTester {
  if (runnerFor === null) return { test: null }
  return {
    test: async (input) => {
      const startedAt = performance.now()
      let result: ObserverTestResult
      try {
        await runnerFor({ provider: input.provider, model: input.model, credentialRef: input.credentialRef, enabled: true, source: 'host' }).run(CHECK_PROMPT)
        result = { ok: true }
      } catch (error: unknown) {
        result = { ok: false, errorClass: toObserverError(error).errorClass }
      }
      log(`observer test provider=${input.provider} result=${result.ok ? 'ok' : result.errorClass} ms=${Math.round(performance.now() - startedAt)}`)
      return result
    },
  }
}

export interface ObserverTestRoute {
  (method: string, readBody: () => Promise<Parsed<unknown>>): Promise<RouteAnswer>
}

export function observerTestRoute(tester: ObserverTester): ObserverTestRoute {
  let running = false
  return async (method, readBody) => {
    if (method !== 'POST') return { status: 405, body: { error: 'method not allowed' } }
    const test = tester.test
    if (test === null) return { status: 503, body: { error: 'the observer is off in this daemon' } }
    if (running) return { status: 409, body: { error: 'a model test is already running' } }
    running = true
    try {
      const body = await readBody()
      const parsed = body.ok ? parseSettingsPut(body.value) : body
      if (!parsed.ok) return { status: 400, body: { error: parsed.error } }
      return { status: 200, body: await test(parsed.value) }
    } finally {
      running = false
    }
  }
}
