import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { relatedByDistance } from '../dashboard/hit-rate'
import { T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { expireRelatedServed, recordRelatedServed, relatedServedSince } from './related-served-store'
import { upsertProject } from './writes'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-related-served-')
})
afterEach(() => temp.cleanup())

test('served lines are kept with their distance and terms, skip ids that are gone, go with their observation and age out', () => {
  upsertProject(temp.store.db, { key: 'p', kind: 'path', displayName: 'p' }, T0)
  const session = seedSession(temp.store, 'claude-code', 's')
  const a = seedObservation(temp.store, { sessionId: session, projectKey: 'p', host: 'claude-code', title: 'a', at: T0 })
  const b = seedObservation(temp.store, { sessionId: session, projectKey: 'p', host: 'claude-code', title: 'b', at: T0 })
  recordRelatedServed(temp.store.db, [{ observationId: a, distance: 0.3, matchedTerms: 2 }, { observationId: b, distance: null, matchedTerms: 3 }, { observationId: 999, distance: 0.1, matchedTerms: 0 }],
    { projectKey: 'p', host: 'claude-code', occurredAt: T0 + 10 })
  expect(relatedServedSince(temp.store.db, T0)).toEqual([
    { observationId: a, projectKey: 'p', host: 'claude-code', distance: 0.3, matchedTerms: 2, occurredAt: T0 + 10 },
    { observationId: b, projectKey: 'p', host: 'claude-code', distance: null, matchedTerms: 3, occurredAt: T0 + 10 },
  ])
  temp.store.db.run('DELETE FROM observations WHERE id = ?', a)
  expect(relatedServedSince(temp.store.db, T0).map((row) => row.observationId)).toEqual([b])
  expect(expireRelatedServed(temp.store.db, T0 + 11, 100)).toBe(1)
  expect(relatedServedSince(temp.store.db, 0)).toEqual([])
})

test('a band counts a line fetched when get_observations in its project returned it within the horizon, after it was served', () => {
  const at = T0
  const served = [
    { observationId: 1, projectKey: 'p', host: 'claude-code', distance: 0.2, matchedTerms: 0, occurredAt: at },
    { observationId: 2, projectKey: 'p', host: 'claude-code', distance: 0.45, matchedTerms: 1, occurredAt: at },
    { observationId: 3, projectKey: 'p', host: 'claude-code', distance: null, matchedTerms: 3, occurredAt: at },
  ]
  const read = (ids: number[], offset: number, projectKey = 'p') => ({ host: 'claude-code', tool: 'get_observations', projectKey, status: 'ok', returnedIds: ids, occurredAt: at + offset }) as never
  const bands = relatedByDistance(served, [read([1], 1_000), read([2], -1_000), read([3], 1_000, 'other')])
  expect(bands).toEqual([
    { band: 'keyword only', served: 1, fetched: 0, rate: 0 },
    { band: '0.00-0.35', served: 1, fetched: 1, rate: 1 },
    { band: '0.35-0.50', served: 1, fetched: 0, rate: 0 },
    { band: '0.50-0.70', served: 0, fetched: 0, rate: null },
  ])
})
