// One observer batch for one session: claim its retryable events, call the
// runner its host's settings name, validate the reply, store the result. Any
// failure (bad settings, missing credential, missing CLI, non-zero exit, bad
// JSON) is recorded on the run; nothing switches to another provider (no
// silent fallback). A failure of the provider as a whole sends the events back
// to pending and backs the provider off; a failure of this batch alone makes
// its events failed-and-retryable.
// Logs carry ids, counts, durations, provider/model and error class only.

import type { Database } from '../sqlite/types'
import {
  type ObserverSession,
  finishRun,
  getObserverSession,
  markDone,
  markFailed,
  markPendingAgain,
  markProcessing,
  markSkipped,
  retryableEvents,
  startRun,
} from '../store/observer-store'
import { setRunUsage } from '../store/impact-reads'
import { repeatedPromptNumbers } from '../store/summary-share'
import { dropEchoes, injectedObservations, linkableIds } from './injected'
import { parseObserverOutput } from './parse'
import { DEFAULT_PROMPT_LIMITS, type PromptLimits, buildObserverPrompt } from './prompt'
import type { RunnerFactory } from './runners'
import { providerBackoff, returnsToPending } from './backoff'
import type { SafetyGate } from './safety-gate'
import { resolveObserverSettings, settingsFingerprint } from './settings'
import { toSourceEvent } from './sources'
import { ObserverError, type ObserverEvent, type ObserverSettings, type RunnerUsage, toObserverError } from './types'
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
  /** The provider keeps failing and waits until retryAt: no run, events untouched. */
  | { status: 'backoff'; provider: string; errorClass: string; failures: number; retryAt: number }
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
      provider: providerOf(choice),
      model: choice.ok ? choice.settings.model : 'unresolved',
      eventCount: batch.length,
      startedAt: now,
    })
  })()
}

function recordFailure(db: Database, runId: number, batch: readonly ObserverEvent[], error: ObserverError, now: number): void {
  db.transaction(() => {
    const ids = batch.map((event) => event.eventId)
    if (returnsToPending(error.errorClass)) markPendingAgain(db, ids)
    else markFailed(db, ids, now)
    finishRun(db, runId, 'failed', `${error.errorClass}: ${error.detail}`, now)
  })()
}

async function observe(deps: ProcessDeps, choice: SettingsChoice, prompt: ReturnType<typeof buildObserverPrompt>): Promise<{ text: string; model: string; usage: RunnerUsage | undefined }> {
  if (!choice.ok) throw choice.error
  const result = await deps.runnerFor(choice.settings).run(prompt)
  return { text: result.text, model: result.model, usage: result.usage }
}

function describe(session: ObserverSession, choice: SettingsChoice, outcome: BatchOutcome, ms: number, retryAt: number | null): string {
  const who = choice.ok ? `provider=${choice.settings.provider} model=${choice.settings.model}` : 'provider=unresolved'
  const head = `observer session=${session.id} host=${session.host} ${who}`
  if (outcome.status === 'succeeded') {
    return `${head} run=${outcome.runId} events=${outcome.events} status=succeeded observations=${outcome.observations} echoes=${outcome.echoes} inserted=${outcome.inserted} downgraded=${outcome.downgraded} summary=${outcome.summary} links=${outcome.links} contradicted=${outcome.contradicted} relations_dropped=${outcome.droppedRelations} ms=${ms}`
  }
  if (outcome.status === 'failed') {
    const retry = retryAt === null ? '' : ` retry_at=${new Date(retryAt).toISOString()}`
    return `${head} run=${outcome.runId} events=${outcome.events} status=failed error=${outcome.errorClass}${retry} ms=${ms}`
  }
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

const providerOf = (choice: SettingsChoice): string => (choice.ok ? choice.settings.provider : 'unresolved')

/**
 * Providers with a failing streak that have a batch in flight, per store.
 * Once a wait ends, one batch tries the provider; the others keep waiting, so
 * a round of parallel failures cannot add several to the count at once.
 */
const probing = new WeakMap<Database, Set<string>>()

function probesOf(db: Database): Set<string> {
  const known = probing.get(db)
  if (known !== undefined) return known
  const fresh = new Set<string>()
  probing.set(db, fresh)
  return fresh
}

/** The backoff outcome while this provider's wait lasts or another batch is trying it, else null. */
function backoffOf(db: Database, choice: SettingsChoice, now: number): BatchOutcome | null {
  const entry = providerBackoff(db, providerOf(choice))
  if (entry === null) return null
  if (entry.retryAt <= now && !probesOf(db).has(entry.provider)) return null
  return { status: 'backoff', provider: entry.provider, errorClass: entry.errorClass, failures: entry.failures, retryAt: entry.retryAt }
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
    if (choice.ok && !choice.settings.enabled) {
      // Off means capture only. What waited is closed here, so switching the observer back on never starts with a batch of old turns.
      markSkipped(deps.db, sessionId)
      return { status: 'disabled' }
    }
    const waiting = backoffOf(deps.db, choice, now())
    if (waiting !== null) return waiting
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
  // Checked again here, with no await before the claim: the gate above can take minutes.
  const waiting = backoffOf(deps.db, choice, now())
  if (waiting !== null) return waiting
  const provider = providerOf(choice)
  const probes = probesOf(deps.db)
  const isProbe = providerBackoff(deps.db, provider) !== null
  if (isProbe) probes.add(provider)
  const startedAt = now()
  const runId = claim(deps.db, session, batch, choice, startedAt)

  let outcome: BatchOutcome
  try {
    const reply = await observe(deps, choice, prompt)
    // Recorded as soon as the model answered: the tokens were spent whether or not its output then parses.
    setRunUsage(deps.db, runId, reply.usage)
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
  } finally {
    if (isProbe) probes.delete(provider)
  }
  const retryAt = outcome.status === 'failed' ? providerBackoff(deps.db, providerOf(choice))?.retryAt ?? null : null
  log(describe(session, choice, outcome, now() - startedAt, retryAt))
  return outcome
}
