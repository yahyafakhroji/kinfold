// The prompt channel's answer in the daemon (P2-B): the delta (new memory
// from other sessions), then earlier memory related to the prompt. Keyword
// matches are local and take milliseconds. The prompt's embedding is a round
// trip to OpenRouter, slower than the hook may wait, so it races a deadline:
// in time, its hits join this prompt's matches; late, it keeps running and
// its hits are parked for the session's next prompt (late-matches.ts). A
// prompt the redaction rules flag is never embedded. The prompt text reaches
// the matcher and the embedder only; nothing here logs or stores it.

import type { Database } from '../sqlite/types'
import { projectDisplayName, sessionDeliveries, sessionStartFor } from '../store/context-store'
import type { ServedRelated } from '../store/related-served-store'
import { currentObservationsByIds, keywordCandidates, matchedTermCounts } from '../store/related-store'
import { NO_FILTERS } from '../store/vector-store'
import type { SemanticAnswer, SemanticRequest } from '../vectors/search'
import { computeDelta } from './delta'
import { type LateHit, type LateMatches, lateSessionKey } from './late-matches'
import { promptSecretRules, promptTerms, termMatches } from './prompt-query'
import { RELATED_BUDGET_TOKENS, RELATED_CANDIDATES, type RelatedCandidate, type RelatedGate, type RelatedMode, buildRelated, isRelated, joinContext, rankRelated } from './related'
import { type ContextRequest, type ContextResult, MAX_CONTEXT_PROMPT_CHARS } from './types'

/** The hook gives the daemon 200 ms (client.ts); measured from when the request arrived, so the delta and keyword work count. */
export const PROMPT_SEMANTIC_DEADLINE_MS = 150
/** How long a late embed may keep running for the next prompt. */
export const LATE_EMBED_DEADLINE_MS = 5_000
/** Vector hits asked per prompt: rows already sent, contradicted or this session's own drop out after, so ask past the 20 that can be served. */
export const RELATED_VECTOR_K = 60
/** Embeds in flight at once; past this a prompt gets keyword matches only, so slow OpenRouter calls cannot pile up. */
export const MAX_INFLIGHT_EMBEDS = 4

/** What happened to the vector half, for the log: never the prompt. */
export type SemanticOutcome = 'ok' | 'late' | 'timeout' | 'unavailable' | 'secret' | 'off' | 'no_prompt' | 'busy' | 'error'

export interface PromptContext extends ContextResult {
  /** The related block alone (empty when none), the tail of `text`: OpenCode keeps it only until the next prompt. */
  relatedText: string
  related: number
  semantic: SemanticOutcome
  /** Time in each half, for the route's log line: numbers only. */
  deltaMs: number
  relatedMs: number
  /** The related lines in `relatedText`, with what earned them; recorded only when the answer is (src/daemon/context-route.ts). */
  relatedServed: ServedRelated[]
}

/** Counts embeds in flight, shared by every prompt the daemon answers. */
export interface EmbedSlots {
  tryTake(): boolean
  release(): void
}

export function createEmbedSlots(max: number = MAX_INFLIGHT_EMBEDS): EmbedSlots {
  let inFlight = 0
  return {
    tryTake: () => {
      if (inFlight >= max) return false
      inFlight += 1
      return true
    },
    release: () => {
      inFlight = Math.max(0, inFlight - 1)
    },
  }
}

export interface PromptContextDeps {
  db: Database
  /** Null when the daemon has no vector search. */
  semantic: ((request: SemanticRequest) => Promise<SemanticAnswer>) | null
  late: LateMatches
  log: (line: string) => void
  gate?: RelatedGate
  deadlineMs?: number
  /** Absent: no cap. */
  slots?: EmbedSlots
  now?: () => number
  /** Monotonic ms, for the deadline. */
  clock?: () => number
}

type Raced = { kind: 'answer'; answer: SemanticAnswer } | { kind: 'deadline' }

function race(pending: Promise<SemanticAnswer>, ms: number): Promise<Raced> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Raced>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'deadline' }), ms)
  })
  return Promise.race([pending.then((answer): Raced => ({ kind: 'answer', answer })), deadline]).finally(() => clearTimeout(timer))
}

interface Matching {
  db: Database
  projectKey: string
  /** This session's sessions row: its own observations are never related memory. */
  sessionId: number | null
  terms: readonly string[]
  each: readonly string[]
}

/** Vector hits as candidates: current rows of the project from other sessions only, with their term counts. */
function vectorCandidates(matching: Matching, hits: readonly { id: number; distance: number }[], exclude: ReadonlySet<number>): RelatedCandidate[] {
  const wanted = hits.filter((hit) => !exclude.has(hit.id))
  const rows = new Map(currentObservationsByIds(matching.db, matching.projectKey, wanted.map((hit) => hit.id), matching.sessionId).map((row) => [row.id, row]))
  const counts = matchedTermCounts(matching.db, [...rows.keys()], matching.each)
  return wanted.flatMap((hit) => {
    const row = rows.get(hit.id)
    return row === undefined ? [] : [{ row, distance: hit.distance, matchedTerms: counts.get(hit.id) ?? 0, promptTerms: matching.terms.length }]
  })
}

function lateCandidates(matching: Matching, hits: readonly LateHit[]): RelatedCandidate[] {
  const rows = new Map(currentObservationsByIds(matching.db, matching.projectKey, hits.map((hit) => hit.id), matching.sessionId).map((row) => [row.id, row]))
  return hits.flatMap((hit) => {
    const row = rows.get(hit.id)
    return row === undefined ? [] : [{ row, distance: hit.distance, matchedTerms: hit.matchedTerms, promptTerms: hit.promptTerms }]
  })
}

function modeFor(inTime: boolean, late: boolean): RelatedMode {
  if (inTime) return 'keyword and meaning'
  return late ? 'keyword, and meaning from the previous prompt' : 'keyword'
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error'
}

/**
 * The delta, then related memory. `startedAt` (deps.clock) is when the
 * request arrived: the semantic deadline counts from there. A failure in the
 * related half keeps the delta and is logged by error name only.
 */
export async function preparePromptContext(deps: PromptContextDeps, request: ContextRequest, projectKey: string, now: number, startedAt?: number): Promise<PromptContext> {
  const clock = deps.clock ?? (() => performance.now())
  const began = startedAt ?? clock()
  const deltaStart = performance.now()
  const delta = computeDelta(deps.db, request, projectKey, now)
  const deltaMs = Math.round(performance.now() - deltaStart)
  const projectName = projectDisplayName(deps.db, projectKey)
  // Sliced here as well as at the parser, so the scan and the embedder see one string.
  const prompt = (request.prompt ?? '').slice(0, MAX_CONTEXT_PROMPT_CHARS).trim()
  if (projectName === null || prompt === '') return { ...delta, relatedText: '', related: 0, semantic: 'no_prompt', deltaMs, relatedMs: 0, relatedServed: [] }
  const relatedStart = performance.now()
  try {
    const related = await relatedFor(deps, { request, projectKey, projectName, prompt, delta, now, deadlineAt: began + (deps.deadlineMs ?? PROMPT_SEMANTIC_DEADLINE_MS), clock })
    return { ...joinContext(delta, related.result), relatedText: related.result.text, related: related.result.observationIds.length, semantic: related.semantic,
      deltaMs, relatedMs: Math.round(performance.now() - relatedStart), relatedServed: related.served }
  } catch (error: unknown) {
    deps.log(`prompt related failed: ${errorName(error)}`)
    return { ...delta, relatedText: '', related: 0, semantic: 'error', deltaMs, relatedMs: Math.round(performance.now() - relatedStart), relatedServed: [] }
  }
}

interface RelatedInputs {
  request: ContextRequest
  projectKey: string
  projectName: string
  prompt: string
  delta: ContextResult
  now: number
  /** Clock time the vector half must answer by. */
  deadlineAt: number
  clock: () => number
}

async function relatedFor(deps: PromptContextDeps, inputs: RelatedInputs): Promise<{ result: ContextResult; semantic: SemanticOutcome; served: ServedRelated[] }> {
  const { request, projectKey, prompt, now } = inputs
  const sessionKey = lateSessionKey(request.host, request.hostSessionId)
  const sessionId = sessionStartFor(deps.db, request.host, request.hostSessionId)?.id ?? null
  const sent = new Set([...sessionDeliveries(deps.db, request.host, request.hostSessionId).sentIds, ...inputs.delta.observationIds])
  const terms = promptTerms(prompt)
  const { any, each } = termMatches(terms)
  const matching: Matching = { db: deps.db, projectKey, sessionId, terms, each }

  // Keyword candidates first, so the vector search can measure them too (item #9).
  const keywordRows = terms.length === 0 ? [] : keywordCandidates(deps.db, { projectKey, match: any, excludeIds: [...sent], excludeSessionId: sessionId, limit: RELATED_CANDIDATES })
  const guardRules = deps.semantic === null ? [] : promptSecretRules(prompt)
  if (guardRules.length > 0) deps.log(`prompt guard rules=${guardRules.join(',')}`)
  let semantic: SemanticOutcome = deps.semantic === null ? 'off' : 'secret'
  let pending: Promise<SemanticAnswer> | null = null
  if (deps.semantic !== null && guardRules.length === 0) {
    if (deps.slots === undefined || deps.slots.tryTake()) {
      const slots = deps.slots
      pending = deps.semantic({ query: prompt, project: projectKey, k: RELATED_VECTOR_K, deadlineMs: LATE_EMBED_DEADLINE_MS, filters: NO_FILTERS, alsoIds: keywordRows.map((row) => row.id) })
        .catch((error: unknown): SemanticAnswer => ({ status: 'unavailable', reason: errorName(error) }))
        .finally(() => slots?.release())
    } else {
      semantic = 'busy'
    }
  }

  const counts = matchedTermCounts(deps.db, keywordRows.map((row) => row.id), each)
  const keyword: RelatedCandidate[] = keywordRows.map((row) => ({ row, matchedTerms: counts.get(row.id) ?? 0, promptTerms: terms.length, distance: null }))

  let vector: RelatedCandidate[] = []
  if (pending !== null) {
    const raced = await race(pending, Math.max(0, inputs.deadlineAt - inputs.clock()))
    if (raced.kind === 'answer') {
      semantic = raced.answer.status
      if (raced.answer.status === 'ok') {
        vector = vectorCandidates(matching, raced.answer.hits, sent)
        deps.log(`prompt semantic ok hits=${vector.length} embed_ms=${raced.answer.embedMs} top=${topDistances(vector)}`)
      }
    } else {
      semantic = 'late'
      parkWhenDone(deps, matching, sessionKey, pending, now)
    }
  }

  const late = lateCandidates(matching, deps.late.take(sessionKey, now).filter((hit) => !sent.has(hit.id)))
  // This prompt's hits first: a row in both keeps this prompt's distance.
  const ranked = rankRelated(keyword, [...vector, ...late], deps.gate ?? isRelated)
  const inTime = new Set(vector.map((candidate) => candidate.row.id))
  const usedLate = ranked.some((row) => !inTime.has(row.id) && late.some((candidate) => candidate.row.id === row.id))
  const result = buildRelated({ projectName: inputs.projectName, observations: ranked, mode: modeFor(vector.length > 0, usedLate), budgetTokens: RELATED_BUDGET_TOKENS, now })
  return { result, semantic, served: servedLines(result.observationIds, keyword, [...vector, ...late]) }
}

/** What earned each served line its place, for the labels table: the vector side's distance (this prompt's first) and the keyword side's terms. */
function servedLines(ids: readonly number[], keyword: readonly RelatedCandidate[], vectorSide: readonly RelatedCandidate[]): ServedRelated[] {
  return ids.map((id) => {
    const near = vectorSide.find((candidate) => candidate.row.id === id)
    const word = keyword.find((candidate) => candidate.row.id === id)
    return { observationId: id, distance: near?.distance ?? null, matchedTerms: word?.matchedTerms ?? near?.matchedTerms ?? 0 }
  })
}

/** The five closest hits as distance/matchedTerms, for tuning the gate from the log; numbers only. */
function topDistances(hits: readonly { distance: number | null; matchedTerms: number }[]): string {
  const top = hits
    .filter((hit) => hit.distance !== null)
    .sort((a, b) => a.distance! - b.distance!)
    .slice(0, 5)
    .map((hit) => `${hit.distance!.toFixed(3)}/${hit.matchedTerms}`)
  return top.length === 0 ? '-' : top.join(',')
}

/** A late answer's hits wait for the session's next prompt; a late failure is only logged. */
function parkWhenDone(deps: PromptContextDeps, matching: Matching, sessionKey: string, pending: Promise<SemanticAnswer>, askedAt: number): void {
  const now = deps.now ?? Date.now
  void pending.then((answer) => {
    if (answer.status !== 'ok') {
      deps.log(`prompt semantic late status=${answer.status}`)
      return
    }
    const hits = vectorCandidates(matching, answer.hits, new Set()).map((candidate) => ({
      id: candidate.row.id, distance: candidate.distance!, matchedTerms: candidate.matchedTerms, promptTerms: candidate.promptTerms,
    }))
    deps.late.put(sessionKey, hits, now(), askedAt)
    deps.log(`prompt semantic late status=ok hits=${hits.length} embed_ms=${answer.embedMs} top=${topDistances(hits)}`)
  }).catch((error: unknown) => deps.log(`prompt semantic late failed: ${errorName(error)}`))
}
