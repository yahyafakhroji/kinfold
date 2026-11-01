// One observer batch for one session: claim its retryable events, call the
// runner its host's settings name, validate the reply, store the result. Any
// failure (bad settings, missing credential, missing CLI, non-zero exit, bad
// JSON) is recorded on the run and the events become failed-and-retryable;
// nothing switches to another provider (plan "No silent fallback").
// Logs carry ids, counts, durations, provider/model and error class only.

import type { Database } from '../sqlite/types'
import {
  type ObserverSession,
  finishRun,
  getObserverSession,
  markDone,
  markFailed,
  markProcessing,
  retryableEvents,
  startRun,
} from '../store/observer-store'
import { repeatedPromptNumbers } from '../store/summary-share'
import { dropEchoes, injectedObservations, linkableIds } from './injected'
import { parseObserverOutput } from './parse'
import { DEFAULT_PROMPT_LIMITS, type PromptLimits, buildObserverPrompt } from './prompt'
import type { RunnerFactory } from './runners'
import { resolveObserverSettings } from './settings'
import { toSourceEvent } from './sources'
import { ObserverError, type ObserverEvent, type ObserverSettings, toObserverError } from './types'
import { type WriteCounts, writeBatchResult } from './write'

export const MAX_BATCH_EVENTS = 50

export interface ProcessDeps {
  db: Database
  runnerFor: RunnerFactory
  now?: () => number
  log?: (line: string) => void
  limits?: PromptLimits
}

export type BatchOutcome =
  | { status: 'idle' }
  | { status: 'disabled' }
  | { status: 'skipped'; events: number }
  | ({ status: 'succeeded'; runId: number; events: number; echoes: number; droppedRelations: number } & WriteCounts)
  | { status: 'failed'; runId: number; events: number; errorClass: string }

type SettingsChoice = { ok: true; settings: ObserverSettings } | { ok: false; error: ObserverError }

function chooseSettings(db: Database, host: string): SettingsChoice {
  try {
    return { ok: true, settings: resolveObserverSettings(db, host) }
  } catch (error: unknown) {
    return { ok: false, error: toObserverError(error) }
  }
}

function claim(db: Database, session: ObserverSession, batch: readonly ObserverEvent[], choice: SettingsChoice, now: number): number {
  return db.transaction(() => {
    markProcessing(db, batch.map((event) => event.eventId))
    return startRun(db, {
      sessionId: session.id,
      host: session.host,
      provider: choice.ok ? choice.settings.provider : 'unresolved',
      model: choice.ok ? choice.settings.model : 'unresolved',
      eventCount: batch.length,
      startedAt: now,
    })
  })()
}

function recordFailure(db: Database, runId: number, batch: readonly ObserverEvent[], error: ObserverError, now: number): void {
  db.transaction(() => {
    markFailed(db, batch.map((event) => event.eventId), now)
    finishRun(db, runId, 'failed', `${error.errorClass}: ${error.detail}`, now)
  })()
}

async function observe(deps: ProcessDeps, choice: SettingsChoice, prompt: ReturnType<typeof buildObserverPrompt>): Promise<{ text: string; model: string }> {
  if (!choice.ok) throw choice.error
  const result = await deps.runnerFor(choice.settings).run(prompt)
  return { text: result.text, model: result.model }
}

function describe(session: ObserverSession, choice: SettingsChoice, outcome: BatchOutcome, ms: number): string {
  const who = choice.ok ? `provider=${choice.settings.provider} model=${choice.settings.model}` : 'provider=unresolved'
  const head = `observer session=${session.id} host=${session.host} ${who}`
  if (outcome.status === 'succeeded') {
    return `${head} run=${outcome.runId} events=${outcome.events} status=succeeded observations=${outcome.observations} echoes=${outcome.echoes} inserted=${outcome.inserted} downgraded=${outcome.downgraded} summary=${outcome.summary} links=${outcome.links} contradicted=${outcome.contradicted} relations_dropped=${outcome.droppedRelations} ms=${ms}`
  }
  if (outcome.status === 'failed') return `${head} run=${outcome.runId} events=${outcome.events} status=failed error=${outcome.errorClass} ms=${ms}`
  return `${head} status=${outcome.status}`
}

export async function processSessionBatch(deps: ProcessDeps, sessionId: number): Promise<BatchOutcome> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const session = getObserverSession(deps.db, sessionId)
  const candidates = session === null ? [] : retryableEvents(deps.db, sessionId, now(), MAX_BATCH_EVENTS)
  if (session === null || candidates.length === 0) return { status: 'idle' }
  // Only session_start / session_end: nothing could be cited, so no model call.
  if (candidates.every((event) => toSourceEvent(event) === null)) {
    markDone(deps.db, candidates.map((event) => event.eventId))
    return { status: 'skipped', events: candidates.length }
  }
  const choice = chooseSettings(deps.db, session.host)
  if (choice.ok && !choice.settings.enabled) return { status: 'disabled' }

  const known = injectedObservations(deps.db, sessionId)
  const repeats = repeatedPromptNumbers(deps.db, session.id, session.projectKey, candidates)
  const prompt = buildObserverPrompt(candidates, deps.limits ?? DEFAULT_PROMPT_LIMITS, known, repeats)
  const included = new Set(prompt.eventIds)
  const batch = candidates.filter((event) => included.has(event.eventId))
  const startedAt = now()
  const runId = claim(deps.db, session, batch, choice, startedAt)

  let outcome: BatchOutcome
  try {
    const reply = await observe(deps, choice, prompt)
    const parsed = parseObserverOutput(reply.text, prompt.eventIds, linkableIds(known, session.projectKey))
    if (!parsed.ok) throw new ObserverError('bad_output', parsed.error)
    const echo = dropEchoes(parsed.output.observations, known, batch, session.projectKey)
    const output = { ...parsed.output, observations: echo.kept, droppedObservations: parsed.output.droppedObservations + echo.echoes }
    const counts = writeBatchResult(deps.db, { runId, output, batch, session, model: reply.model, now: now() })
    outcome = { status: 'succeeded', runId, events: batch.length, echoes: echo.echoes, droppedRelations: output.droppedRelations, ...counts }
  } catch (error: unknown) {
    const failure = toObserverError(error)
    recordFailure(deps.db, runId, batch, failure, now())
    outcome = { status: 'failed', runId, events: batch.length, errorClass: failure.errorClass }
  }
  log(describe(session, choice, outcome, now() - startedAt))
  return outcome
}
