// The prompt channel's answer in the daemon: the delta (new memory from
// other sessions), then earlier memory related to the prompt. Everything is
// answered by one deadline, counted from when the request arrived, because
// the hook stops waiting soon after. The store reads (the delta, keyword
// candidates, rows for vector hits) run in the recall reader worker when the
// daemon has one, so a busy store or a long dashboard report never holds the
// thread that answers; the prompt's embedding races the same deadline. A
// part that misses it keeps running and its hits are parked for the
// session's next prompt (late-matches.ts); a delta that misses is worked out
// again next time, since nothing of it was recorded. A prompt the redaction
// rules flag is never embedded. The prompt text reaches the matcher and the
// embedder only, wrappers removed (prompt-text.ts); nothing here logs or
// stores it.

import type { Database } from '../sqlite/types'
import { projectDisplayName } from '../store/context-store'
import type { ServedRelated } from '../store/related-served-store'
import { NO_FILTERS } from '../store/vector-store'
import type { SemanticAnswer, SemanticRequest } from '../vectors/search'
import { type StoreReader, inlineStoreReader } from '../workers/store-reader'
import type { CandidateSource, SearchTrace } from '../debug/trace'
import { explainRelated } from './explain'
import { type LateHit, type LateMatches, lateSessionKey } from './late-matches'
import { promptSecretRules, promptTermCandidates, termMatches } from './prompt-query'
import { searchablePrompt } from './prompt-text'
import type { RecallPromptAnswer, RecallRowsAnswer, TermCounts } from './recall-reads'
import { RELATED_BUDGET_TOKENS, RELATED_CANDIDATES, type RelatedCandidate, type RelatedGate, type RelatedMode, buildRelated, isRelated, joinContext, rankRelated } from './related'
import { type ContextRequest, type ContextResult, EMPTY_CONTEXT, MAX_CONTEXT_PROMPT_CHARS } from './types'

/** The hook gives the daemon 200 ms (client.ts); measured from when the request arrived, so every read and the embed count. */
export const PROMPT_SEMANTIC_DEADLINE_MS = 150
/** How long a late embed or recall read may keep running for the next prompt. */
export const LATE_EMBED_DEADLINE_MS = 5_000
/** Vector hits asked per prompt: rows already sent, contradicted or this session's own drop out after, so ask past the 20 that can be served. */
export const RELATED_VECTOR_K = 60
/** Embeds in flight at once; past this a prompt gets keyword matches only, so slow OpenRouter calls cannot pile up. */
export const MAX_INFLIGHT_EMBEDS = 4

/** What happened to the vector half, for the log: never the prompt. */
export type SemanticOutcome = 'ok' | 'late' | 'timeout' | 'unavailable' | 'secret' | 'off' | 'no_prompt' | 'busy' | 'error'
/** What happened to the store reads: in time, past the deadline (parked), or failed. */
export type ReadOutcome = 'ok' | 'late' | 'error' | 'none'

export interface PromptContext extends ContextResult {
  /** The related block alone (empty when none), the tail of `text`: OpenCode keeps it only until the next prompt. */
  relatedText: string
  related: number
  semantic: SemanticOutcome
  read: ReadOutcome
  /** Time in each half, for the route's log line: numbers only. deltaMs is the store read the delta comes with. */
  deltaMs: number
  relatedMs: number
  /** The related lines in `relatedText`, with what earned them; recorded only when the answer is (src/daemon/context-route.ts). */
  relatedServed: ServedRelated[]
  /** What the related search weighed and why, for `kinfold watch --debug`; null when none ran. Built only when called, after the answer. */
  explain: () => Promise<SearchTrace | null>
}

const NO_SEARCH = async (): Promise<null> => null

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
  /** Where the store reads run; default the db connection, on this thread. The daemon passes its recall reader. */
  reads?: StoreReader
  gate?: RelatedGate
  deadlineMs?: number
  /** Absent: no cap. */
  slots?: EmbedSlots
  now?: () => number
  /** Monotonic ms, for the deadline. */
  clock?: () => number
}

type Raced<T> = { kind: 'answer'; value: T } | { kind: 'failed'; error: unknown } | { kind: 'deadline' }

function race<T>(pending: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'deadline' }), ms)
  })
  const settled = pending.then((value): Raced<T> => ({ kind: 'answer', value }), (error: unknown): Raced<T> => ({ kind: 'failed', error }))
  return Promise.race([settled, deadline]).finally(() => clearTimeout(timer))
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'error'
}

/** What the reads are about: the terms the recall read matched on, and where rows may come from. */
interface Matching {
  projectKey: string
  sessionKey: string
  terms: readonly string[]
  any: string
  each: readonly string[]
}

type Where = Pick<Matching, 'projectKey' | 'sessionKey'>

function matchingFor(where: Where, terms: readonly string[]): Matching {
  const { any, each } = termMatches(terms)
  return { ...where, terms, any, each }
}

const countsOf = (counts: TermCounts): Map<number, number> => new Map(counts.map(([id, n]) => [id, n]))

/**
 * Candidates from a rows read, for the rows still current here. A hit of
 * this prompt is counted against this prompt's terms; a parked hit keeps the
 * counts of the prompt that found it.
 */
function candidatesFrom(rows: RecallRowsAnswer, hits: readonly ({ id: number; distance: number } | LateHit)[], promptTerms: number): RelatedCandidate[] {
  const byId = new Map(rows.rows.map((row) => [row.id, row]))
  const counts = countsOf(rows.counts)
  return hits.flatMap((hit) => {
    const row = byId.get(hit.id)
    if (row === undefined) return []
    return 'promptTerms' in hit
      ? [{ row, distance: hit.distance, matchedTerms: hit.matchedTerms, promptTerms: hit.promptTerms }]
      : [{ row, distance: hit.distance, matchedTerms: counts.get(hit.id) ?? 0, promptTerms }]
  })
}

function modeFor(inTime: boolean, late: boolean): RelatedMode {
  if (inTime) return 'keyword and meaning'
  return late ? 'keyword, and meaning from the previous prompt' : 'keyword'
}

/**
 * The delta, then related memory. `startedAt` (deps.clock) is when the
 * request arrived: the deadline counts from there. A failure in the related
 * half keeps the delta and is logged by error name only.
 */
/** `deadlineMs`, when given, wins over deps.deadlineMs: a hub answering a device has only what the device still waits. */
export async function preparePromptContext(deps: PromptContextDeps, request: ContextRequest, projectKey: string, now: number, startedAt?: number, deadlineMs?: number): Promise<PromptContext> {
  const clock = deps.clock ?? (() => performance.now())
  const began = startedAt ?? clock()
  const deadlineAt = began + (deadlineMs ?? deps.deadlineMs ?? PROMPT_SEMANTIC_DEADLINE_MS)
  const left = (): number => Math.max(0, deadlineAt - clock())
  const reads = deps.reads ?? inlineStoreReader(deps.db, '')
  const nothing = (read: ReadOutcome, semantic: SemanticOutcome, deltaMs: number): PromptContext =>
    ({ ...EMPTY_CONTEXT, relatedText: '', related: 0, semantic, read, deltaMs, relatedMs: 0, relatedServed: [], explain: NO_SEARCH })
  // A primary-key read: cheap on this thread, and it keeps an unknown project from costing an embed.
  const projectName = projectDisplayName(deps.db, projectKey)
  if (projectName === null) return nothing('none', 'no_prompt', 0)
  const raw = (request.prompt ?? '').slice(0, MAX_CONTEXT_PROMPT_CHARS).trim()
  const query = searchablePrompt(raw)
  const candidates = query === '' ? [] : promptTermCandidates(raw)
  const sessionKey = lateSessionKey(request.host, request.hostSessionId)

  const readStart = performance.now()
  const reading = reads.run('recallPrompt', {
    host: request.host, hostSessionId: request.hostSessionId, projectKey, now, terms: candidates, limit: RELATED_CANDIDATES,
  }, { expireMs: LATE_EMBED_DEADLINE_MS })
  const embedding = query === '' ? { pending: null, semantic: 'no_prompt' as SemanticOutcome } : startEmbed(deps, projectKey, query, reading)

  const read = await race(reading, left())
  const deltaMs = Math.round(performance.now() - readStart)
  if (read.kind !== 'answer') {
    if (read.kind === 'failed') deps.log(`prompt recall read failed: ${errorName(read.error)}`)
    else parkLate(deps, reads, { projectKey, sessionKey }, reading, embedding.pending, now)
    return nothing(read.kind === 'failed' ? 'error' : 'late', embedding.pending === null ? embedding.semantic : 'late', deltaMs)
  }
  const answer = read.value
  if (answer.projectName === null || query === '') return { ...nothing('ok', 'no_prompt', deltaMs), ...answer.delta }
  const matching = matchingFor({ projectKey, sessionKey }, answer.terms)
  const relatedStart = performance.now()
  try {
    const related = await relatedFor(deps, reads, { matching, answer, projectName, now, left, query, embedding })
    return { ...joinContext(answer.delta, related.result), relatedText: related.result.text, related: related.result.observationIds.length, semantic: related.semantic, read: 'ok',
      deltaMs, relatedMs: Math.round(performance.now() - relatedStart), relatedServed: related.served, explain: related.explain }
  } catch (error: unknown) {
    deps.log(`prompt related failed: ${errorName(error)}`)
    return { ...nothing('ok', 'error', deltaMs), ...answer.delta, relatedMs: Math.round(performance.now() - relatedStart) }
  }
}

interface Embedding {
  pending: Promise<SemanticAnswer> | null
  /** The outcome when nothing was embedded: off, secret or busy. */
  semantic: SemanticOutcome
}

/** Starts the embed at once, beside the store read; the keyword candidates it also measures follow when that read answers. */
function startEmbed(deps: PromptContextDeps, projectKey: string, query: string, reading: Promise<RecallPromptAnswer>): Embedding {
  if (deps.semantic === null) return { pending: null, semantic: 'off' }
  const guardRules = promptSecretRules(query)
  if (guardRules.length > 0) {
    deps.log(`prompt guard rules=${guardRules.join(',')}`)
    return { pending: null, semantic: 'secret' }
  }
  if (deps.slots !== undefined && !deps.slots.tryTake()) return { pending: null, semantic: 'busy' }
  const slots = deps.slots
  const alsoIds = reading.then((answer) => answer.keywordRows.map((row) => row.id), () => [])
  const pending = deps.semantic({ query, project: projectKey, k: RELATED_VECTOR_K, deadlineMs: LATE_EMBED_DEADLINE_MS, filters: NO_FILTERS, alsoIds })
    .catch((error: unknown): SemanticAnswer => ({ status: 'unavailable', reason: errorName(error) }))
    .finally(() => slots?.release())
  return { pending, semantic: 'ok' }
}

interface RelatedInputs {
  matching: Matching
  answer: RecallPromptAnswer
  projectName: string
  now: number
  left: () => number
  query: string
  embedding: Embedding
}

type DroppedHit = { id: number; distance: number | null; matchedTerms?: number; source?: CandidateSource; outcome: 'already delivered' | 'not current here' }

async function relatedFor(deps: PromptContextDeps, reads: StoreReader, inputs: RelatedInputs): Promise<{ result: ContextResult; semantic: SemanticOutcome; served: ServedRelated[]; explain: () => Promise<SearchTrace> }> {
  const { matching, answer, now } = inputs
  const sent = new Set(answer.sentIds)
  const terms = matching.terms.length
  const counts = countsOf(answer.keywordCounts)
  const keyword: RelatedCandidate[] = answer.keywordRows.map((row) => ({ row, matchedTerms: counts.get(row.id) ?? 0, promptTerms: terms, distance: null }))

  let semantic: SemanticOutcome = inputs.embedding.semantic
  let hits: { id: number; distance: number }[] = []
  let space: string | null = null
  let embedMs = 0
  const pending = inputs.embedding.pending
  if (pending !== null) {
    const raced = await race(pending, inputs.left())
    if (raced.kind === 'answer') {
      semantic = raced.value.status
      if (raced.value.status === 'ok') {
        hits = raced.value.hits
        space = raced.value.model ?? null
        embedMs = raced.value.embedMs
      }
    } else {
      semantic = 'late'
      parkVectorHits(deps, reads, matching, answer.sessionId, pending, now)
    }
  }

  const parked = deps.late.take(matching.sessionKey, now).filter((hit) => !sent.has(hit.id))
  const fresh = hits.filter((hit) => !sent.has(hit.id))
  let vector: RelatedCandidate[] = []
  let late: RelatedCandidate[] = []
  const ids = [...new Set([...fresh.map((hit) => hit.id), ...parked.map((hit) => hit.id)])]
  if (ids.length > 0) {
    const rowsRead = reads.run('recallRows', { projectKey: matching.projectKey, ids, sessionId: answer.sessionId, each: matching.each }, { expireMs: LATE_EMBED_DEADLINE_MS })
    const rows = await race(rowsRead, inputs.left())
    if (rows.kind === 'answer') {
      vector = candidatesFrom(rows.value, fresh, terms)
      late = candidatesFrom(rows.value, parked, terms)
      if (pending !== null && semantic === 'ok') deps.log(`prompt semantic ok hits=${vector.length} embed_ms=${embedMs} top=${topDistances(vector)}`)
    } else {
      // Rows came too late to serve: what this prompt found and what was parked wait for the next one.
      void rowsRead.then((value) => parkCandidates(deps, matching.sessionKey, [...candidatesFrom(value, fresh, terms), ...candidatesFrom(value, parked, terms)], now), () => {})
    }
  }

  const lateKeyword = late.filter((candidate) => candidate.distance === null)
  const lateVector = late.filter((candidate) => candidate.distance !== null)
  const lateIds = new Set(late.map((candidate) => candidate.row.id))
  const deltaIds = new Set(answer.delta.observationIds)
  // This prompt's matches first: a row in both keeps this prompt's distance.
  const ranked = rankRelated([...keyword, ...lateKeyword], [...vector, ...lateVector], deps.gate ?? isRelated)
  const inTime = new Set(vector.map((candidate) => candidate.row.id))
  const usedLate = ranked.some((row) => !inTime.has(row.id) && lateIds.has(row.id))
  const mode = modeFor(vector.length > 0, usedLate)
  const result = buildRelated({ projectName: inputs.projectName, observations: ranked, mode, budgetTokens: RELATED_BUDGET_TOKENS, now })
  const dropped = droppedHits(hits, sent, vector)
  const explain = async (): Promise<SearchTrace> => {
    const delivered = await deliveredKeywordMatches(reads, matching, answer, dropped)
    return explainRelated({
      db: deps.db, gate: deps.gate, mode, semantic, space, terms: matching.terms, query: pending === null ? null : inputs.query,
      keyword: [...keyword, ...lateKeyword], vector: [...vector, ...lateVector], lateIds, served: result.observationIds,
      // The delta's own lines are shown as new memory, so they are not listed again as already delivered.
      dropped: [...dropped, ...delivered].filter((hit) => !deltaIds.has(hit.id)),
    })
  }
  return { result, semantic, served: servedLines(result.observationIds, [...keyword, ...lateKeyword], [...vector, ...lateVector]), explain }
}

/** Keyword matches the session already has, for the trace only (after the answer): the candidate read leaves them out. */
async function deliveredKeywordMatches(reads: StoreReader, matching: Matching, answer: RecallPromptAnswer, already: readonly DroppedHit[]): Promise<DroppedHit[]> {
  if (matching.terms.length === 0 || answer.sentIds.length === 0) return []
  const listed = new Set(already.map((hit) => hit.id))
  const found = await reads.run('recallDelivered', { projectKey: matching.projectKey, any: matching.any, each: matching.each, sessionId: answer.sessionId, sent: answer.sentIds, limit: RELATED_CANDIDATES })
  const counts = countsOf(found.counts)
  return found.rows.filter((row) => !listed.has(row.id)).map((row) => ({ id: row.id, distance: null, matchedTerms: counts.get(row.id) ?? 0, source: 'keyword', outcome: 'already delivered' }))
}

/** Hits that never reached the gate: sent to this session already, or not a current row of this project from another session. */
function droppedHits(hits: readonly { id: number; distance: number }[], sent: ReadonlySet<number>, kept: readonly RelatedCandidate[]): DroppedHit[] {
  const keptIds = new Set(kept.map((candidate) => candidate.row.id))
  return hits.flatMap((hit): DroppedHit[] => {
    if (sent.has(hit.id)) return [{ id: hit.id, distance: hit.distance, outcome: 'already delivered' }]
    return keptIds.has(hit.id) ? [] : [{ id: hit.id, distance: hit.distance, outcome: 'not current here' }]
  })
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

function parkCandidates(deps: PromptContextDeps, sessionKey: string, candidates: readonly RelatedCandidate[], askedAt: number): number {
  const hits: LateHit[] = candidates.map((candidate) => ({ id: candidate.row.id, distance: candidate.distance, matchedTerms: candidate.matchedTerms, promptTerms: candidate.promptTerms }))
  deps.late.add(sessionKey, hits, (deps.now ?? Date.now)(), askedAt)
  return hits.length
}

/** An embed past the deadline: its hits wait for the session's next prompt, once their rows are read; a late failure is only logged. */
function parkVectorHits(deps: PromptContextDeps, reads: StoreReader, matching: Matching, sessionId: number | null, pending: Promise<SemanticAnswer>, askedAt: number): void {
  void pending.then(async (answer) => {
    if (answer.status !== 'ok') {
      deps.log(`prompt semantic late status=${answer.status}`)
      return
    }
    const rows = await reads.run('recallRows', { projectKey: matching.projectKey, ids: answer.hits.map((hit) => hit.id), sessionId, each: matching.each }, { expireMs: LATE_EMBED_DEADLINE_MS })
    const candidates = candidatesFrom(rows, answer.hits, matching.terms.length)
    parkCandidates(deps, matching.sessionKey, candidates, askedAt)
    deps.log(`prompt semantic late status=ok hits=${candidates.length} embed_ms=${answer.embedMs} top=${topDistances(candidates)}`)
  }).catch((error: unknown) => deps.log(`prompt semantic late failed: ${errorName(error)}`))
}

/** A store read past the deadline: its keyword matches, and the embed's hits when it ends, wait for the next prompt. */
function parkLate(deps: PromptContextDeps, reads: StoreReader, where: Where, reading: Promise<RecallPromptAnswer>, pending: Promise<SemanticAnswer> | null, askedAt: number): void {
  void reading.then((answer) => {
    const matching = matchingFor(where, answer.terms)
    const counts = countsOf(answer.keywordCounts)
    const keyword = answer.keywordRows.map((row): RelatedCandidate => ({ row, distance: null, matchedTerms: counts.get(row.id) ?? 0, promptTerms: matching.terms.length }))
    const parked = parkCandidates(deps, matching.sessionKey, keyword, askedAt)
    deps.log(`prompt recall read late keyword=${parked}`)
    if (pending !== null) parkVectorHits(deps, reads, matching, answer.sessionId, pending, askedAt)
  }).catch((error: unknown) => deps.log(`prompt recall read late failed: ${errorName(error)}`))
}
