import { expect, test } from 'bun:test'
import { MAX_VECTOR_DISTANCE, fuseRanks } from './fusion'
import type { IndexRow } from './reader'

const row = (id: number): IndexRow => ({
  id, projectKey: 'p', host: 'claude-code', type: 'discovery', evidence: 'tool-verified', title: `#${id}`,
  contradictedBy: null, contradictionKind: null, occurredAt: 0, confirmedBy: 0,
})
const ids = (rows: readonly IndexRow[]) => rows.map((r) => r.id)
const near = (id: number, distance = 0.2) => ({ row: row(id), distance })

test('with no vector hits the FTS order stands', () => {
  expect(ids(fuseRanks([row(3), row(1), row(2)], []))).toEqual([3, 1, 2])
})

test('a row in both lists beats the top row of one list', () => {
  expect(ids(fuseRanks([row(1), row(2)], [near(2), near(9)]))[0]).toBe(2)
})

test('each row appears once, and vector-only rows join after equal-ranked FTS rows', () => {
  expect(ids(fuseRanks([row(1), row(2)], [near(7), near(8)]))).toEqual([1, 7, 2, 8])
})

test('hits past the distance cutoff are not matches', () => {
  expect(ids(fuseRanks([row(1)], [near(5, MAX_VECTOR_DISTANCE + 0.01), near(6, MAX_VECTOR_DISTANCE)]))).toEqual([1, 6])
})

test('vector hits alone are ranked by distance order', () => {
  expect(ids(fuseRanks([], [near(4, 0.1), near(2, 0.3), near(9, 0.5)]))).toEqual([4, 2, 9])
})
