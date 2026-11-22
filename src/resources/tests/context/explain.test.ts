import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, openTempStore } from '../observer/test-support'
import { type ExplainInputs, explainRelated } from '../../context/explain'
import { type RelatedCandidate, isRelated, refusalRule } from '../../context/related'
import type { PackObservation } from '../../context/types'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-explain-')
})
afterEach(() => temp.cleanup())

const row = (id: number): PackObservation => ({ id, host: 'opencode', title: `memory ${id}`, evidence: 'tool-verified', contradictedBy: null, contradictionKind: null, occurredAt: 1, confirmedBy: 0 })
const candidate = (id: number, matchedTerms: number, promptTerms: number): RelatedCandidate => ({ row: row(id), matchedTerms, promptTerms, distance: null })

function inputs(extra: Partial<ExplainInputs>): ExplainInputs {
  return {
    db: temp.store.db, gate: undefined, mode: 'keyword', semantic: 'late', space: null, terms: ['alpha', 'beta', 'gamma'], query: null,
    keyword: [], parkedKeyword: [], vector: [], lateIds: new Set(), dropped: [], served: [], ...extra,
  }
}

// The hub's trace: a 3-term prompt, #33910 matching 2 of them, shown as "2 terms · 2 of 3 prompt terms needed" and below cutoff.
test('a keyword match with 2 of a 3-term prompt passes the gate', () => {
  expect(isRelated(candidate(33910, 2, 3))).toBe(true)
})

test('the trace weighs a row by this prompt when it is also parked from an earlier, longer prompt', () => {
  // The earlier prompt had 7 terms, so its own copy of the row needed 3; the gate passes the row on this prompt's copy.
  const traced = explainRelated(inputs({ keyword: [candidate(33910, 2, 3)], parkedKeyword: [candidate(33910, 2, 7)], lateIds: new Set([33910]) }))
  expect(traced.candidates).toEqual([{ id: 33910, title: 'memory 33910', source: 'keyword', distance: null, matchedTerms: 2, outcome: 'over budget' }])
})

test('a row parked from an earlier prompt is labelled so, and its rule names that prompt', () => {
  const traced = explainRelated(inputs({ parkedKeyword: [candidate(33910, 2, 7)], lateIds: new Set([33910]) }))
  expect(traced.candidates[0]).toMatchObject({ source: 'previous prompt', outcome: 'below cutoff', rule: "2 terms matched, 3 needed (a third of the previous prompt's 7)" })
})

test('the keyword rule says how many terms matched and how many were needed', () => {
  expect(refusalRule(candidate(1, 2, 9))).toBe("2 terms matched, 3 needed (a third of this prompt's 9)")
  expect(refusalRule(candidate(1, 1, 3))).toBe('1 term matched, 2 needed')
  expect(refusalRule({ ...candidate(1, 1, 3), distance: 0.6 })).toBe('not within 0.35 in meaning, 1 term matched, 2 needed')
})
