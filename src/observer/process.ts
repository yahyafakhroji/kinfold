// One observer batch for one session: claim its retryable events, call the
// runner its host's settings name, validate the reply, store the result. Any
// failure (bad settings, missing credential, missing CLI, non-zero exit, bad
// JSON) is recorded on the run and the events become failed-and-retryable;
// nothing switches to another provider (no silent fallback).
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
import type { SafetyGate } from './safety-gate'
import { resolveObserverSettings, settingsFingerprint } from './settings'
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
  /** The daemon's safety gate for CLI login observers. Without it, no batch is gated. */
  safety?: SafetyGate
}

export type BatchOutcome =
  | { status: 'idle' }
  | { status: 'disabled' }
  /** The safety gate stopped this observer: no run, events untouched. */
  | { status: 'blocked'; errorClass: string }
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

interface PendingBatch {
  session: ObserverSession
  candidates: ObserverEvent[]
}

/** The session and its retryable events, or the outcome when there is nothing to observe. */
function pendingBatch(db: Database, sessionId: number, now: number): PendingBatch | BatchOutcome {
  const session = getObserverSession(db, sessionId)
  const candidates = session === null ? [] : retryableEvents(db, sessionId, now, MAX_BATCH_EVENTS)
  if (session === null || candidates.length === 0) return { status: 'idle' }
  // Only session_start / session_end: nothing could be cited, so no model call.
  if (candidates.every((event) => toSourceEvent(event) === null)) {
    markDone(db, candidates.map((event) => event.eventId))
    return { status: 'skipped', events: candidates.length }
  }
  return { session, candidates }
}

/** Gate passes per batch before giving up to the next tick, if settings keep changing during the checks. */
const MAX_GATE_PASSES = 3

type Gated = { pending: PendingBatch; choice: SettingsChoice } | BatchOutcome

/**
 * Settings, then the safety gate. The gate may run a planted check for
 * minutes, so after an ok it reads the batch and the settings again; changed
 * settings go through the enabled check and the gate once more.
 */
async function gated(deps: ProcessDeps, sessionId: number, first: PendingBatch, now: () => number): Promise<Gated> {
  let pending = first
  let choice = chooseSettings(deps.db, pending.session.host)
  for (let pass = 0; pass < MAX_GATE_PASSES; pass += 1) {
    if (choice.ok && !choice.settings.enabled) return { status: 'disabled' }
    if (!choice.ok || deps.safety === undefined) return { pending, choice }
    const gate = await deps.safety.check(choice.settings)
    if (!gate.ok) return { status: 'blocked', errorClass: gate.errorClass }
    const again = pendingBatch(deps.db, sessionId, now())
    if ('status' in again) return again
    pending = again
    const checked = choice.settings
    choice = chooseSettings(deps.db, pending.session.host)
    if (choice.ok && settingsFingerprint(choice.settings) === settingsFingerprint(checked)) return { pending, choice }
  }
  return { status: 'idle' }
}

export async function processSessionBatch(deps: ProcessDeps, sessionId: number): Promise<BatchOutcome> {
  const now = deps.now ?? Date.now
  const log = deps.log ?? (() => {})
  const first = pendingBatch(deps.db, sessionId, now())
  if ('status' in first) return first
  const ready = await gated(deps, sessionId, first, now)
  if ('status' in ready) return ready
  const { pending, choice } = ready
  const { session, candidates } = pending

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
    // A tool ran during a normal batch: record it on the gate, which stops this observer.
    if (failure.errorClass === 'tool_attempt' && choice.ok && deps.safety !== undefined) await deps.safety.reportToolAttempt(choice.settings)
  }
  log(describe(session, choice, outcome, now() - startedAt))
  return outcome
}
