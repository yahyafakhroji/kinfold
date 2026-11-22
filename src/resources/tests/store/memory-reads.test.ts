import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { type BrowseFilters, browseObservations, observationDetail } from './memory-reads'
import { insertLinks, settleContradictions } from './observation-links'

// The memory browser's list rows carry confirmedBy, counted the way
// the MCP reader counts it: current confirmers of the same project only.

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-memory-reads-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
})
afterEach(() => temp.cleanup())

const HOUR = 3_600_000
const ALL: BrowseFilters = { project: null, host: null, type: null, evidence: null, match: null, limit: 50, offset: 0 }
const seed = (title: string, hoursIn: number, evidence: 'tool-verified' | 'interpretation' = 'tool-verified') =>
  seedObservation(temp.store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title, evidence, at: T0 + hoursIn * HOUR })
const link = (from: number, to: number, kind: 'confirms' | 'contradicts') => insertLinks(temp.store.db, from, [{ kind, observationId: to }], T0)
const counts = () => Object.fromEntries(browseObservations(temp.store.db, ALL).rows.map((row) => [row.id, row.confirmedBy]))

test('list rows carry confirmedBy: 0 without confirmers, N with them, and a contradicted source does not count', () => {
  const target = seed('Route returns 3', 0)
  const alone = seed('Spool order', 1)
  const first = seed('Route still returns 3', 2)
  const second = seed('Route returns 3 again', 3)
  const third = seed('Route returns 3 once more', 4, 'interpretation')
  for (const from of [first, second, third]) link(from, target, 'confirms')
  expect(counts()).toMatchObject({ [target]: 3, [alone]: 0, [first]: 0 })

  // A newer row contradicts the third confirmer; it stops counting.
  const later = seed('That route check was wrong', 5)
  link(later, third, 'contradicts')
  expect(settleContradictions(temp.store.db, [third])).toBe(1)
  expect(counts()).toMatchObject({ [target]: 2, [third]: 0, [later]: 0 })
  expect(observationDetail(temp.store.db, target)?.confirmedBy).toBe(2)
})

test('a store without observation_links (before v5) lists every row with confirmedBy 0', () => {
  const target = seed('Route returns 3', 0)
  link(seed('Route still returns 3', 1), target, 'confirms')
  temp.store.db.run('DROP TABLE observation_links')
  const rows = browseObservations(temp.store.db, ALL).rows
  expect(rows.map((row) => [row.confirmedBy, row.contradictionKind])).toEqual([[0, null], [0, null]])
})
