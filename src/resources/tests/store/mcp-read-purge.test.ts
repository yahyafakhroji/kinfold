import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { purge } from '../data-control/purge'
import { DAY_MS, applyRetention, describeRetention } from '../data-control/retention'
import { type TempStore, openTempStore } from '../observer/test-support'
import { insertMcpRead } from './mcp-read-store'
import { upsertProject, upsertSession } from './writes'

const NOW = 1_792_900_000_000

let temp: TempStore
let observation: number
beforeEach(() => {
  temp = openTempStore('sam-mcp-read-purge-')
  upsertProject(temp.store.db, { key: 'org/a', kind: 'git-remote', displayName: 'a' }, NOW)
  const session = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc', projectKey: 'org/a', cwd: '/a', occurredAt: NOW })
  observation = seedObservation(temp.store, { sessionId: session, projectKey: 'org/a', host: 'opencode', title: 'Purge me', at: NOW })
  const reads: [string, string | null, number, number[]][] = [
    ['org/a', 'claude-code', NOW - 40 * DAY_MS, [observation]],
    ['org/a', 'opencode', NOW - DAY_MS, [observation, 777]],
    ['org/b', 'claude-code', NOW - DAY_MS, [5]],
    ['*', null, NOW - 2 * DAY_MS, [observation]],
  ]
  for (const [projectKey, host, at, returnedIds] of reads) {
    insertMcpRead(temp.store.db, { tool: 'get_observations', projectKey, host, returnedIds, rows: returnedIds.length, ms: 1, status: 'ok' }, at)
  }
})
afterEach(() => temp.cleanup())

const reads = () => temp.store.db.query('SELECT project_key AS project, host, returned_ids AS ids FROM mcp_reads ORDER BY id').all()
const run = (target: Parameters<typeof purge>[1], dryRun = false) => purge(temp.store.db, target, { dryRun, now: () => NOW })

test('a project purge deletes that project\'s reads; a dry run only counts them', () => {
  expect(run({ kind: 'project', key: 'org/a' }, true).counts.mcp_reads).toBe(2)
  expect(reads()).toHaveLength(4)
  expect(run({ kind: 'project', key: 'org/a' }).counts.mcp_reads).toBe(2)
  // The '*' read loses the purged id; org/b keeps its row.
  expect(reads()).toEqual([{ project: 'org/b', host: 'claude-code', ids: '[5]' }, { project: '*', host: null, ids: '[]' }])
})

test('a host purge deletes that host\'s reads, and a date-range purge deletes the reads in range', () => {
  expect(run({ kind: 'host', host: 'claude-code' }).counts.mcp_reads).toBe(2)
  expect((reads() as { host: string | null }[]).map((row) => row.host)).toEqual(['opencode', null])
  expect(run({ kind: 'range', after: NOW - 3 * DAY_MS, before: NOW - DAY_MS + 1 }).counts.mcp_reads).toBe(2)
  expect(reads()).toEqual([])
})

test('an observation purge trims its id from every read and keeps the rows', () => {
  expect(run({ kind: 'observation', id: observation }).counts.mcp_reads).toBe(0)
  expect((reads() as { ids: string }[]).map((row) => row.ids)).toEqual(['[]', '[777]', '[5]', '[]'])
})

test('retention deletes reads older than the events setting (30 days by default), once', () => {
  const first = applyRetention(temp.store.db, NOW)
  expect(first.mcpReads).toBe(1)
  expect(describeRetention(first)).toContain('mcp_reads=1')
  expect(reads()).toHaveLength(3)
  expect(applyRetention(temp.store.db, NOW).mcpReads).toBe(0)
  temp.store.db.run("UPDATE data_settings SET value = NULL WHERE key = 'retention.events'")
  expect(applyRetention(temp.store.db, NOW + 365 * DAY_MS).mcpReads).toBe(0)
})
