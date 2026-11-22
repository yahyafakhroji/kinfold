import { expect, test } from 'bun:test'
import { FRAME_CLOSE, FRAME_OPEN } from './pack'
import { type RelatedCandidate, buildRelated, isRelated, joinContext, rankRelated } from './related'
import type { PackObservation } from './types'

const row = (id: number, title = `Observation ${id}`): PackObservation => ({
  id, host: 'opencode', title, evidence: 'tool-verified', contradictedBy: null, contradictionKind: null, occurredAt: 0, confirmedBy: 0,
})
const kw = (id: number, matchedTerms: number): RelatedCandidate => ({ row: row(id), matchedTerms, promptTerms: 3, distance: null })
const vec = (id: number, distance: number): RelatedCandidate => ({ row: row(id), matchedTerms: 0, promptTerms: 3, distance })

test('a row in both lists outranks rows at the top of one, and gets its distance from the vector side', () => {
  const seen: (number | null)[] = []
  const ranked = rankRelated([kw(1, 2), kw(2, 2)], [vec(3, 0.2), vec(2, 0.3)], (c) => (seen.push(c.distance), true))
  expect(ranked.map((r) => r.id)).toEqual([2, 1, 3])
  expect(seen.slice(0, 2)).toEqual([null, 0.3])
})

test('the gate drops candidates on either side', () => {
  expect(rankRelated([kw(1, 1), kw(2, 3)], [vec(3, 0.9)], (c) => c.matchedTerms >= 2 || (c.distance ?? 2) < 0.5).map((r) => r.id)).toEqual([2])
})

const gate = (matchedTerms: number, promptTerms: number, distance: number | null): boolean => isRelated({ row: row(1), matchedTerms, promptTerms, distance })

test('keyword alone needs two terms and a third of the prompt', () => {
  expect(gate(1, 1, null)).toBe(false)
  expect(gate(1, 2, null)).toBe(false)
  expect(gate(2, 2, null)).toBe(true)
  expect(gate(2, 3, null)).toBe(true)
  expect(gate(2, 9, null)).toBe(false)
  expect(gate(3, 9, null)).toBe(true)
  expect(gate(4, 15, null)).toBe(false)
  expect(gate(5, 15, null)).toBe(true)
  expect(gate(0, 0, null)).toBe(false)
})

test('meaning alone needs a close vector; a shared term relaxes it; a far vector vetoes keywords', () => {
  expect(gate(0, 5, 0.35)).toBe(true)
  expect(gate(0, 5, 0.4)).toBe(false)
  expect(gate(1, 5, 0.5)).toBe(true)
  expect(gate(1, 5, 0.55)).toBe(false)
  expect(gate(2, 3, 0.7)).toBe(true)
  expect(gate(2, 3, 0.71)).toBe(false)
  expect(gate(5, 5, 1.2)).toBe(false)
})

test('related lines are framed, name how they matched, and stop at the budget', () => {
  const built = buildRelated({ projectName: 'repo', observations: [row(1), row(2, 'x'.repeat(200))], mode: 'keyword', budgetTokens: 120, now: 0 })
  expect(built.text.startsWith(FRAME_OPEN)).toBe(true)
  expect(built.text.endsWith(FRAME_CLOSE)).toBe(true)
  expect(built.text).toContain('(matched by keyword)')
  expect(built.observationIds).toEqual([1])
  expect(buildRelated({ projectName: 'repo', observations: [], mode: 'keyword', budgetTokens: 120, now: 0 }).text).toBe('')
})

test('the delta comes first, and an empty side adds nothing', () => {
  const a = { text: 'A', observationIds: [1], tokens: 1 }
  const b = { text: 'B', observationIds: [2], tokens: 1 }
  const empty = { text: '', observationIds: [], tokens: 0 }
  expect(joinContext(a, b)).toEqual({ text: 'A\nB', observationIds: [1, 2], tokens: 1 })
  expect(joinContext(a, empty)).toBe(a)
  expect(joinContext(empty, b)).toBe(b)
})

test('a row twice on the vector side counts once, at its first distance', () => {
  const seen: (number | null)[] = []
  const ranked = rankRelated([kw(1, 2)], [vec(1, 0.7), vec(2, 0.3), vec(1, 0.1)], (c) => (seen.push(c.distance), true))
  expect(seen[0]).toBe(0.7)
  expect(ranked.map((r) => r.id)).toEqual([1, 2])
  // Row 1 is in both lists; row 2 only on the vector side, three times. Counted each time, row 2 would win.
  expect(rankRelated([kw(1, 2)], [vec(2, 0.2), vec(1, 0.3), vec(2, 0.2), vec(2, 0.2)], () => true).map((r) => r.id)).toEqual([1, 2])
})
