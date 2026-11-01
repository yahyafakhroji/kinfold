import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, openTempStore } from '../observer/test-support'
import { recordInjection } from '../store/context-store'
import { type InjectedIds, type StoredMcpRead, insertMcpRead } from '../store/mcp-read-store'
import { FETCH_HORIZON_MS, fetchAfterInject, groupReads, searchHit } from './hit-rate'
import { metricsSummary } from './metrics'

const HOUR = 3_600_000
const NOW = 1_792_900_000_000

const injected = (projectKey: string, occurredAt: number, observationIds: number[]): InjectedIds => ({ projectKey, host: 'claude-code', channel: 'session_start', occurredAt, observationIds })
const read = (over: Partial<StoredMcpRead>): StoredMcpRead => ({
  occurredAt: NOW, projectKey: 'p', host: 'claude-code', tool: 'get_observations', returnedIds: [], rows: 0, ms: 1, status: 'ok', ...over,
})

test('fetch-after-inject counts distinct (project, id) pairs fetched in the same project within 24 h after an injection', () => {
  const injections = [
    injected('p', NOW, [1, 2, 3, 4]),
    injected('p', NOW + HOUR, [1]), // same pair again: still one pair
    injected('q', NOW, [5, 6]),
  ]
  const reads = [
    read({ projectKey: 'p', returnedIds: [1], occurredAt: NOW + 2 * HOUR }), // hit
    read({ projectKey: 'p', returnedIds: [2], occurredAt: NOW - HOUR }), // before the injection: no
    read({ projectKey: 'p', returnedIds: [3], occurredAt: NOW + FETCH_HORIZON_MS + 1 }), // past 24 h: no
    read({ projectKey: 'other', returnedIds: [4], occurredAt: NOW + HOUR }), // another project: no
    read({ projectKey: '*', returnedIds: [5], occurredAt: NOW + HOUR }), // every-project scope: yes
    read({ projectKey: 'q', returnedIds: [6], occurredAt: NOW + HOUR, tool: 'search' }), // search is not a fetch
    read({ projectKey: 'q', returnedIds: [6], occurredAt: NOW + HOUR, status: 'not_found' }),
  ]
  expect(fetchAfterInject(injections, reads)).toEqual({ injected: 6, fetched: 2, rate: 2 / 6, horizonMs: FETCH_HORIZON_MS })
  expect(fetchAfterInject([], reads)).toEqual({ injected: 0, fetched: 0, rate: null, horizonMs: FETCH_HORIZON_MS })
})

test('a fetch 25 h after the first injection counts when a later injection of the same pair is within 24 h', () => {
  const injections = [injected('p', NOW, [7]), injected('p', NOW + 10 * HOUR, [7])]
  expect(fetchAfterInject(injections, [read({ returnedIds: [7], occurredAt: NOW + 25 * HOUR })]).fetched).toBe(1)
})

test('search-hit is the share of searches that ran and returned at least one row; reads group by host and tool', () => {
  const reads = [
    read({ tool: 'search', rows: 3 }), read({ tool: 'search', rows: 0 }), read({ tool: 'search', rows: 1, host: null }),
    read({ tool: 'search', rows: 0, status: 'usage_error' }), read({ tool: 'timeline', rows: 4 }), read({ tool: 'get_observations', status: 'not_found' }),
  ]
  expect(searchHit(reads)).toEqual({ searches: 3, withRows: 2, rate: 2 / 3 })
  expect(searchHit([])).toEqual({ searches: 0, withRows: 0, rate: null })
  expect(groupReads(reads)).toEqual([
    { host: 'claude-code', tool: 'get_observations', calls: 1, errors: 0 },
    { host: 'claude-code', tool: 'search', calls: 3, errors: 1 },
    { host: 'claude-code', tool: 'timeline', calls: 1, errors: 0 },
    { host: 'unknown', tool: 'search', calls: 1, errors: 0 },
  ])
})

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-hit-rate-')
})
afterEach(() => temp.cleanup())

test('the summary reads seeded rows over the window and leaves older ones out', () => {
  const inject = (ids: number[], at: number) => recordInjection(temp.store.db, {
    sessionId: null, host: 'opencode', hostSessionId: 'oc', projectKey: 'org/repo', observationIds: ids, channel: 'request', tokens: 10, occurredAt: at, durationMs: 2,
  })
  inject([1, 2], NOW - 2 * HOUR)
  inject([9], NOW - 8 * 24 * HOUR) // outside 7d
  insertMcpRead(temp.store.db, { tool: 'get_observations', projectKey: 'org/repo', host: 'opencode', returnedIds: [2], rows: 1, ms: 1, status: 'ok' }, NOW - HOUR)
  insertMcpRead(temp.store.db, { tool: 'search', projectKey: 'org/repo', host: 'opencode', returnedIds: [], rows: 0, ms: 1, status: 'ok' }, NOW - HOUR)
  const summary = metricsSummary(temp.store.db, '7d', NOW)
  expect(summary.hitRate).toMatchObject({
    window: '7d', since: NOW - 7 * 24 * HOUR,
    fetchAfterInject: { injected: 2, fetched: 1, rate: 0.5 },
    searchHit: { searches: 1, withRows: 0, rate: 0 },
    reads: [{ host: 'opencode', tool: 'get_observations', calls: 1, errors: 0 }, { host: 'opencode', tool: 'search', calls: 1, errors: 0 }],
  })
  expect(summary.injectionLatency).toEqual([{ host: 'opencode', channel: 'request', durationMs: { samples: 1, p50: 2, p95: 2 } }])
  expect(metricsSummary(temp.store.db, '24h', NOW + 23 * HOUR).hitRate.fetchAfterInject).toMatchObject({ injected: 0, rate: null })
})
