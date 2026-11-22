// The prompt path's reads of memory.db, as plain functions of a connection,
// so the daemon runs them in its recall reader worker and, until that is up,
// on its own connection, with one result either way (src/resources/workers). Each takes
// and returns plain data: ids, counts, titles of memory, never the prompt.

import type { Database } from '../sqlite/types'
import { projectDisplayName, sessionDeliveries, sessionStartFor } from '../store/context-store'
import { currentObservationsByIds, keywordCandidates, matchedTermCounts, observationCount, termDocCounts } from '../store/related-store'
import { termMatches } from './prompt-query'
import { computeDelta } from './delta'
import type { ContextResult, PackObservation } from './types'

export interface RecallPromptArgs {
  host: string
  hostSessionId: string
  projectKey: string
  now: number
  /** The prompt's candidate terms, best first (promptTermCandidates); the read keeps the ones worth matching. */
  terms: readonly string[]
  limit: number
}

/** Terms matched per prompt. */
export const MATCHED_TERMS = 8
/** A term in more than this share of memories is too common to tell them apart, and its doclist is the costly part of a match. */
export const COMMON_TERM_SHARE = 0.1
/** A small store keeps its terms: below this many holders a term is never common. */
export const COMMON_TERM_FLOOR = 5
/** A prompt of only common words still matches on its rarest few. */
export const MIN_MATCHED_TERMS_KEPT = 2

/**
 * The terms a prompt is matched on: those the index holds and that are not
 * common, rarest first up to `max`, returned in the order given (own words
 * before pasted text). When fewer than two are left, the two rarest that the
 * index holds at all. Rare terms are what BM25 weighs most, and common ones
 * cost the most to match: on a 30,000-memory store, matching only these was
 * about four times cheaper.
 */
export function chooseTerms(db: Database, candidates: readonly string[], max: number = MATCHED_TERMS): string[] {
  if (candidates.length === 0) return []
  const counts = termDocCounts(db, candidates)
  const limit = Math.max(COMMON_TERM_FLOOR, observationCount(db) * COMMON_TERM_SHARE)
  const held = candidates.filter((term) => (counts.get(term) ?? 0) > 0)
  const rarest = (terms: readonly string[]): string[] => [...terms].sort((a, b) => counts.get(a)! - counts.get(b)!)
  const rare = held.filter((term) => counts.get(term)! <= limit)
  const kept = new Set(rare.length >= MIN_MATCHED_TERMS_KEPT ? rarest(rare).slice(0, max) : rarest(held).slice(0, Math.min(max, MIN_MATCHED_TERMS_KEPT)))
  return candidates.filter((term) => kept.has(term))
}

/** [observation id, terms it matched]: an array, so the worker's answer and the inline one are the same data. */
export type TermCounts = readonly (readonly [number, number])[]

export interface RecallKeywordAnswer {
  /** Null for a project the store has never seen: no related memory. */
  projectName: string | null
  /** This session's sessions row; its own observations are never related memory. */
  sessionId: number | null
  /** The terms matched on (chooseTerms): the counts and the gate measure against these. */
  terms: string[]
  /** What the session was already sent; the delta read beside this one adds its own ids. */
  sentIds: number[]
  keywordRows: PackObservation[]
  keywordCounts: TermCounts
}

const counted = (counts: Map<number, number>): TermCounts => [...counts.entries()]

export type RecallDeltaArgs = Pick<RecallPromptArgs, 'host' | 'hostSessionId' | 'projectKey' | 'now'>

/**
 * The delta alone: index reads of a few rows, so it stays quick even when the
 * keyword read beside it is slow, and the new memory reaches the prompt either way.
 */
export function recallDelta(db: Database, args: RecallDeltaArgs): ContextResult {
  return computeDelta(db, args, args.projectKey, args.now)
}

/**
 * Keyword candidates that leave out what the session was already sent. It
 * runs beside the delta read, so a row the delta is about to send can come
 * back here too; the prompt path drops it from this side.
 */
export function recallKeyword(db: Database, args: RecallPromptArgs): RecallKeywordAnswer {
  const projectName = projectDisplayName(db, args.projectKey)
  if (projectName === null) return { projectName: null, sessionId: null, terms: [], sentIds: [], keywordRows: [], keywordCounts: [] }
  const terms = chooseTerms(db, args.terms)
  const { any, each } = termMatches(terms)
  const sessionId = sessionStartFor(db, args.host, args.hostSessionId)?.id ?? null
  const sent = sessionDeliveries(db, args.host, args.hostSessionId).sentIds
  const keywordRows = terms.length === 0 ? [] : keywordCandidates(db, { projectKey: args.projectKey, match: any, excludeIds: sent, excludeSessionId: sessionId, limit: args.limit })
  return { projectName, sessionId, terms, sentIds: sent, keywordRows, keywordCounts: counted(matchedTermCounts(db, keywordRows.map((row) => row.id), each)) }
}

/** Sets a new worker's connection up for prompts: the vocabulary table chooseTerms reads, and the memory count it keeps. */
export function recallWarm(db: Database): { terms: number } {
  return { terms: chooseTerms(db, ['kinfold']).length }
}

export interface RecallRowsArgs {
  projectKey: string
  ids: readonly number[]
  sessionId: number | null
  each: readonly string[]
}

export interface RecallRowsAnswer {
  rows: PackObservation[]
  counts: TermCounts
}

/** Current rows of the project among `ids`, from other sessions, with their term counts: what vector and parked hits need. */
export function recallRows(db: Database, args: RecallRowsArgs): RecallRowsAnswer {
  const rows = currentObservationsByIds(db, args.projectKey, args.ids, args.sessionId)
  return { rows, counts: counted(matchedTermCounts(db, rows.map((row) => row.id), args.each)) }
}

export interface RecallDeliveredArgs {
  projectKey: string
  any: string
  each: readonly string[]
  sessionId: number | null
  sent: readonly number[]
  limit: number
}

/** Keyword matches the session already has, for `kinfold watch --debug`: the candidate read leaves them out. */
export function recallDelivered(db: Database, args: RecallDeliveredArgs): RecallRowsAnswer {
  const sent = new Set(args.sent)
  const rows = keywordCandidates(db, { projectKey: args.projectKey, match: args.any, excludeIds: [], excludeSessionId: args.sessionId, limit: args.limit }).filter((row) => sent.has(row.id))
  return { rows, counts: counted(matchedTermCounts(db, rows.map((row) => row.id), args.each)) }
}
