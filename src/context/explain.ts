// The related search's reasons, for `kinfold watch --debug`. prompt-context.ts
// hands over what it already holds (the candidates, the hits it dropped, the
// ids it served) and this turns them into one list with an outcome each. It
// runs only when the daemon records the trace, after the hook has its answer,
// so none of its work (the title lookup included) is on the prompt's clock.

import type { CandidateSource, SearchTrace, TraceCandidate } from '../debug/trace'
import type { Database } from '../sqlite/types'
import { titlesFor } from '../store/context-store'
import { oneLine } from './pack'
import { type RelatedCandidate, type RelatedGate, isRelated, refusalRule } from './related'

/** Enough to see why the lines on the turn won; the rest of the 60 vector hits are noise. */
export const MAX_TRACED_CANDIDATES = 25
/** The start of the redacted prompt, so the meaning query can be told apart; the full text stays with the store. */
export const TRACED_QUERY_CHARS = 80

export interface ExplainInputs {
  db: Database
  gate: RelatedGate | undefined
  mode: string
  semantic: string
  space: string | null
  terms: readonly string[]
  /** The redacted prompt, when the meaning half embedded it. */
  query: string | null
  keyword: readonly RelatedCandidate[]
  /** This prompt's hits, then the previous prompt's parked ones. */
  vector: readonly RelatedCandidate[]
  lateIds: ReadonlySet<number>
  /** Vector hits left out before the gate, with why. */
  dropped: readonly { id: number; distance: number | null; matchedTerms?: number; source?: CandidateSource; outcome: 'already delivered' | 'not current here' }[]
  served: readonly number[]
}

interface Weighed {
  id: number
  title: string
  source: CandidateSource
  distance: number | null
  matchedTerms: number
  passed: boolean
  rule: string
}

/** One entry per id, gated as rankRelated gates it: by the keyword path (with the vector's distance) or the vector path. */
function weigh(inputs: ExplainInputs): Weighed[] {
  const gate = inputs.gate ?? isRelated
  const vectorById = new Map<number, RelatedCandidate>()
  for (const candidate of inputs.vector) if (!vectorById.has(candidate.row.id)) vectorById.set(candidate.row.id, candidate)
  const keywordById = new Map(inputs.keyword.map((candidate) => [candidate.row.id, candidate]))
  const ids = [...new Set([...keywordById.keys(), ...vectorById.keys()])]
  return ids.map((id) => {
    const word = keywordById.get(id)
    const near = vectorById.get(id)
    const merged: RelatedCandidate = word !== undefined ? { ...word, distance: near?.distance ?? word.distance } : near!
    const passed = (word !== undefined && gate(merged)) || (near !== undefined && near.distance !== null && gate(near))
    const source: CandidateSource = near === undefined ? 'keyword' : inputs.lateIds.has(id) && !(word !== undefined) ? 'previous prompt' : word !== undefined ? 'keyword and meaning' : 'meaning'
    return { id, title: merged.row.title, source, distance: merged.distance, matchedTerms: merged.matchedTerms, passed, rule: inputs.gate === undefined ? refusalRule(merged) : 'refused by the gate' }
  })
}

function closestFirst(a: TraceCandidate, b: TraceCandidate): number {
  if (a.distance !== null && b.distance !== null) return a.distance - b.distance
  if (a.distance !== b.distance) return a.distance === null ? 1 : -1
  return b.matchedTerms - a.matchedTerms
}

export function explainRelated(inputs: ExplainInputs): SearchTrace {
  const served = new Set(inputs.served)
  const weighed: TraceCandidate[] = weigh(inputs).map((entry) => {
    const base = { id: entry.id, title: entry.title, source: entry.source, distance: entry.distance, matchedTerms: entry.matchedTerms }
    if (served.has(entry.id)) return { ...base, outcome: 'sent' as const }
    return entry.passed ? { ...base, outcome: 'over budget' as const } : { ...base, outcome: 'below cutoff' as const, rule: entry.rule }
  })
  const titles = titlesFor(inputs.db, inputs.dropped.map((hit) => hit.id))
  const dropped: TraceCandidate[] = inputs.dropped.map((hit) => ({ id: hit.id, title: titles.get(hit.id) ?? '', source: hit.source ?? 'meaning', distance: hit.distance, matchedTerms: hit.matchedTerms ?? 0, outcome: hit.outcome }))
  const sent = inputs.served.flatMap((id) => weighed.filter((candidate) => candidate.id === id))
  const rest = [...weighed.filter((candidate) => !served.has(candidate.id)), ...dropped].sort(closestFirst)
  return {
    mode: inputs.mode,
    semantic: inputs.semantic,
    space: inputs.space,
    terms: [...inputs.terms],
    query: inputs.query === null ? '' : oneLine(inputs.query, TRACED_QUERY_CHARS),
    candidates: [...sent, ...rest].slice(0, MAX_TRACED_CANDIDATES),
  }
}
