// The daemon's pack service: build a project's packs, keep them current, and
// serve one with an injection record. A stored pack is served as is while it
// is fresh; it is rebuilt when the project gained an observation since (for
// example from once.ts) or when its ages ("5h") have gone stale. Packs are
// also rebuilt right after every observer write (daemon.ts).

import type { Database } from '../sqlite/types'
import {
  type PackRow,
  latestNextSteps,
  maxObservationId,
  packObservations,
  projectDisplayName,
  readPack,
  recordInjection,
  sessionIdFor,
  upsertPack,
} from '../store/context-store'
import { computeDelta } from './delta'
import { FRAME_OPEN, buildPack } from './pack'
import { type ContextRequest, type ContextResult, EMPTY_CONTEXT, HOST_PROFILES, type HostProfile, PACK_BUDGETS, hostProfileFor } from './types'

/** Candidates read per build; budgets fit about 80 lines, so this leaves room for merges. */
export const PACK_CANDIDATES = 200
/** Ages in a pack are relative to built_at; past this the daemon rebuilds before serving. */
export const PACK_MAX_AGE_MS = 60 * 60_000

export interface ServedContext extends ContextResult {
  /** Null when nothing was served (empty pack), so no injection was recorded. */
  injectionId: number | null
  rebuilt: boolean
}

/** Builds and stores one pack. Null for a project the store has never seen (no row to key it on). */
export function rebuildPack(db: Database, projectKey: string, profile: HostProfile, now: number): PackRow | null {
  const projectName = projectDisplayName(db, projectKey)
  if (projectName === null) return null
  const builtFromMaxId = maxObservationId(db, projectKey)
  const steps = latestNextSteps(db, projectKey)
  const built = buildPack({
    projectName,
    observations: packObservations(db, projectKey, PACK_CANDIDATES),
    nextSteps: steps?.text ?? null,
    nextStepsRepeats: steps?.repeatCount ?? 1,
    budgetTokens: PACK_BUDGETS[profile],
    now,
  })
  const row: PackRow = {
    projectKey,
    hostProfile: profile,
    body: built.text,
    tokenCount: built.tokens,
    observationIds: built.observationIds,
    builtFromMaxId,
    builtAt: now,
  }
  upsertPack(db, row)
  return row
}

/** Every host profile, in one transaction. Returns how many packs were written. */
export function rebuildProjectPacks(db: Database, projectKey: string, now: number): number {
  return db.transaction(() => HOST_PROFILES.filter((profile) => rebuildPack(db, projectKey, profile, now) !== null).length)()
}

/** A pack stored under an older frame tag is stale, so the first use after a rename rebuilds it. */
export function isFresh(pack: PackRow, maxId: number, now: number): boolean {
  const frameCurrent = pack.body === '' || pack.body.startsWith(FRAME_OPEN)
  return frameCurrent && pack.builtFromMaxId === maxId && now - pack.builtAt < PACK_MAX_AGE_MS
}

/** The stored pack when fresh, else a rebuilt one. */
export function currentPack(db: Database, projectKey: string, profile: HostProfile, now: number): { pack: PackRow | null; rebuilt: boolean } {
  const stored = readPack(db, projectKey, profile)
  if (stored !== null && isFresh(stored, maxObservationId(db, projectKey), now)) return { pack: stored, rebuilt: false }
  return { pack: rebuildPack(db, projectKey, profile, now), rebuilt: true }
}

export interface PreparedContext extends ContextResult {
  rebuilt: boolean
}

/** The pack text for the request's project and host profile, rebuilt when stale; records nothing. */
export function preparePack(db: Database, request: ContextRequest, projectKey: string, now: number): PreparedContext {
  const { pack, rebuilt } = currentPack(db, projectKey, hostProfileFor(request.host), now)
  if (pack === null || pack.body === '') return { ...EMPTY_CONTEXT, rebuilt }
  return { text: pack.body, observationIds: pack.observationIds, tokens: pack.tokenCount, rebuilt }
}

/** The pack for session_start and request, the delta for prompt (src/context/delta.ts); records nothing. */
export function prepareContext(db: Database, request: ContextRequest, projectKey: string, now: number): PreparedContext {
  return request.channel === 'prompt' ? { ...computeDelta(db, request, projectKey, now), rebuilt: false } : preparePack(db, request, projectKey, now)
}

/** One injections row for a non-empty answer; null (nothing recorded) for an empty one. */
export function recordServed(db: Database, request: ContextRequest, projectKey: string, served: ContextResult, now: number, durationMs: number | null): number | null {
  if (served.text === '') return null
  return recordInjection(db, {
    sessionId: sessionIdFor(db, request.host, request.hostSessionId),
    host: request.host,
    hostSessionId: request.hostSessionId,
    projectKey,
    observationIds: served.observationIds,
    channel: request.channel,
    tokens: served.tokens,
    occurredAt: now,
    durationMs,
  })
}

/** POST /context without timing: prepare, then one injections row when it is not empty. */
export function serveContext(db: Database, request: ContextRequest, projectKey: string, now: number, durationMs: number | null = null): ServedContext {
  const prepared = prepareContext(db, request, projectKey, now)
  return { ...prepared, injectionId: recordServed(db, request, projectKey, prepared, now, durationMs) }
}
