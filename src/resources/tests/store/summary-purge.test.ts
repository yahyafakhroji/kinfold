import { afterEach, beforeEach, expect, test } from 'bun:test'
import { purge } from '../data-control/purge'
import { T0, type TempStore, openTempStore } from '../observer/test-support'
import type { PurgeTarget } from './purge-store'
import { writeSharedSummary } from './summary-share'
import { insertPrompt, upsertProject, upsertSession } from './writes'

// Purge coverage for shared summaries (v7): a summary goes with its last
// pointing prompt and stays while a surviving prompt uses it; the kept row
// moves off a purged owner and its count is redone.

let temp: TempStore
let s1: number
let s2: number
const NOTICE = 'Coordinator notice: worker done.'
const HOUR = 3_600_000

beforeEach(() => {
  temp = openTempStore('sam-share-purge-')
  const db = temp.store.db
  upsertProject(db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, T0)
  s1 = upsertSession(db, { host: 'claude-code', hostSessionId: 'one', projectKey: 'org/repo', cwd: '/w', occurredAt: T0 })
  s2 = upsertSession(db, { host: 'opencode', hostSessionId: 'two', projectKey: 'org/repo', cwd: '/w', occurredAt: T0 + 2 * HOUR })
  db.run('UPDATE sessions SET last_event_at = started_at')
  insertPrompt(db, { sessionId: s1, promptNumber: 1, text: NOTICE, occurredAt: T0 })
  insertPrompt(db, { sessionId: s2, promptNumber: 1, text: NOTICE, occurredAt: T0 + 2 * HOUR })
  const summary = { request: 'notice', learned: 'l', completed: 'c', nextSteps: 'n' }
  writeSharedSummary(db, { sessionId: s1, projectKey: 'org/repo', promptNumber: 1, summary, occurredAt: T0, now: T0 })
  writeSharedSummary(db, { sessionId: s2, projectKey: 'org/repo', promptNumber: 1, summary: null, occurredAt: T0 + 2 * HOUR, now: T0 + 2 * HOUR })
})
afterEach(() => temp.cleanup())

const run = (target: PurgeTarget, dryRun = false) => purge(temp.store.db, target, { dryRun, now: () => T0 + 5 * HOUR })
const summaryRows = () => temp.store.db.query('SELECT session_id AS s, prompt_number AS n, request, repeat_count AS count, last_seen_at AS seen FROM summaries').all()

test('the fixture shares one summary between the two sessions', () => {
  expect(summaryRows()).toEqual([{ s: s1, n: 1, request: 'notice', count: 2, seen: T0 + 2 * HOUR }])
})

test('purging a session that only points at the summary keeps it, with the count and last seen redone', () => {
  const dry = run({ kind: 'session', id: s2 }, true)
  const real = run({ kind: 'session', id: s2 })
  expect(real.counts).toEqual(dry.counts)
  expect(real.counts.summaries).toBe(0)
  expect(summaryRows()).toEqual([{ s: s1, n: 1, request: 'notice', count: 1, seen: T0 }])
})

test('purging the owner session keeps the summary for the surviving prompt and moves it there; purging that one too removes it', () => {
  expect(run({ kind: 'session', id: s1 }).counts.summaries).toBe(0)
  expect(summaryRows()).toEqual([{ s: s2, n: 1, request: 'notice', count: 1, seen: T0 + 2 * HOUR }])
  const dry = run({ kind: 'session', id: s2 }, true)
  expect(dry.counts.summaries).toBe(1)
  expect(run({ kind: 'session', id: s2 }).counts).toEqual(dry.counts)
  expect(summaryRows()).toEqual([])
})

test('a project purge that takes every pointer removes the shared summary', () => {
  expect(run({ kind: 'project', key: 'org/repo' }).counts.summaries).toBe(1)
  expect(summaryRows()).toEqual([])
})

test('a host purge spares the summary another host still points at', () => {
  expect(run({ kind: 'host', host: 'claude-code' }).counts.summaries).toBe(0)
  expect(summaryRows()).toEqual([{ s: s2, n: 1, request: 'notice', count: 1, seen: T0 + 2 * HOUR }])
})

test('a range purge over the first prompt keeps the summary for the later one', () => {
  const report = run({ kind: 'range', after: null, before: T0 + HOUR })
  expect(report.counts).toMatchObject({ sessions: 1, prompts: 1, summaries: 0 })
  expect(summaryRows()).toEqual([{ s: s2, n: 1, request: 'notice', count: 1, seen: T0 + 2 * HOUR }])
})

test('purging one prompt keeps the summary; purging the last pointing prompt removes it', () => {
  const ids = temp.store.db.query<{ id: number }, []>('SELECT id FROM prompts ORDER BY id').all().map((row) => row.id)
  expect(run({ kind: 'prompt', id: ids[0]! }).counts).toMatchObject({ prompts: 1, summaries: 0 })
  expect(summaryRows()).toEqual([{ s: s2, n: 1, request: 'notice', count: 1, seen: T0 + 2 * HOUR }])
  expect(run({ kind: 'prompt', id: ids[1]! }).counts).toMatchObject({ prompts: 1, summaries: 1 })
  expect(summaryRows()).toEqual([])
})

test('an explicit summary purge removes the shared row and clears every pointer', () => {
  const id = (temp.store.db.query('SELECT id FROM summaries').get() as { id: number }).id
  expect(run({ kind: 'summary', id }).counts.summaries).toBe(1)
  expect(temp.store.db.query('SELECT count(*) AS n FROM prompts WHERE summary_id IS NOT NULL').get()).toEqual({ n: 0 })
})
