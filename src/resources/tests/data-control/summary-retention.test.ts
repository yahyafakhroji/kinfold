import { afterEach, beforeEach, expect, test } from 'bun:test'
import { T0, type TempStore, openTempStore } from '../observer/test-support'
import { writeDataSettings } from '../store/data-settings-store'
import { scopeFor } from '../store/purge-store'
import { writeSharedSummary } from '../store/summary-share'
import { insertPrompt, upsertProject, upsertSession } from '../store/writes'
import { purge } from './purge'
import { DAY_MS, applyRetention, previewRetention } from './retention'

// Summaries age from their last use: coalesce(last_seen_at,
// occurred_at). A shared summary first written long ago but repeated lately
// stays; the preview counts what a run deletes; a date-range purge still
// means "written in that range".

let temp: TempStore
const NOW = T0 + 40 * DAY_MS
const REPEATED = 'Coordinator notice: worker done.'
const ONCE = 'Explain the spool layout.'
const SUMMARY = { request: 'r', learned: 'l', completed: 'c', nextSteps: 'n' }

function session(hostSessionId: string, at: number): number {
  const db = temp.store.db
  const id = upsertSession(db, { host: 'claude-code', hostSessionId, projectKey: 'org/repo', cwd: '/w', occurredAt: at })
  db.query('UPDATE sessions SET last_event_at = started_at WHERE id = ?').run(id)
  return id
}

/** One prompt and its summary write; a repeat of earlier text shares the earlier row. */
function prompt(hostSessionId: string, text: string, at: number, summary: typeof SUMMARY | null): void {
  const sessionId = session(hostSessionId, at)
  insertPrompt(temp.store.db, { sessionId, promptNumber: 1, text, occurredAt: at })
  writeSharedSummary(temp.store.db, { sessionId, projectKey: 'org/repo', promptNumber: 1, summary, occurredAt: at, now: at })
}

beforeEach(() => {
  temp = openTempStore('sam-summary-retention-')
  upsertProject(temp.store.db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, T0)
  prompt('a1', REPEATED, NOW - 10 * DAY_MS, { ...SUMMARY, request: 'repeated' })
  prompt('a2', REPEATED, NOW - DAY_MS, null)
  prompt('b1', ONCE, NOW - 10 * DAY_MS, { ...SUMMARY, request: 'once' })
})
afterEach(() => temp.cleanup())

const requests = (): string[] =>
  temp.store.db.query<{ request: string }, []>('SELECT request FROM summaries ORDER BY request').all().map((row) => row.request)

test('the fixture: the repeated summary was first written 10 days ago and last seen 1 day ago', () => {
  expect(temp.store.db.query('SELECT request, occurred_at AS at, last_seen_at AS seen FROM summaries ORDER BY request').all()).toEqual([
    { request: 'once', at: NOW - 10 * DAY_MS, seen: NOW - 10 * DAY_MS },
    { request: 'repeated', at: NOW - 10 * DAY_MS, seen: NOW - DAY_MS },
  ])
})

test('a summary first seen before the cutoff but last seen after it survives; one last seen before it expires', () => {
  writeDataSettings(temp.store.db, { retention: { summaries: 7 } }, NOW)
  expect(applyRetention(temp.store.db, NOW).summaries).toBe(1)
  expect(requests()).toEqual(['repeated'])
})

test('a summary without last_seen_at (written before v7) ages from occurred_at', () => {
  temp.store.db.run('UPDATE summaries SET last_seen_at = NULL')
  writeDataSettings(temp.store.db, { retention: { summaries: 7 } }, NOW)
  expect(applyRetention(temp.store.db, NOW).summaries).toBe(2)
  expect(requests()).toEqual([])
})

test('preview counts equal applied counts on the same seed, at 30, 7 and 1 days', () => {
  for (const days of [30, 7, 1]) {
    const change = { retention: { summaries: days } }
    const preview = previewRetention(temp.store.db, change, NOW).tables.summaries
    const dry = purge(temp.store.db, { kind: 'expire', table: 'summaries', before: NOW - days * DAY_MS }, { dryRun: true, now: () => NOW })
    writeDataSettings(temp.store.db, change, NOW)
    const applied = applyRetention(temp.store.db, NOW).summaries
    expect({ days, preview: preview.rows, dry: dry.counts.summaries }).toEqual({ days, preview: applied, dry: applied })
  }
  // At 1 day the cutoff equals the repeat's last use, and expiry is strictly older.
  expect(requests()).toEqual(['repeated'])
})

test('the preview of a 7-day setting names the stale summary only, with its text size', () => {
  const preview = previewRetention(temp.store.db, { retention: { summaries: 7 } }, NOW).tables.summaries
  expect(preview).toEqual({ rows: 1, bytes: 'once'.length + 3 })
  expect(requests()).toEqual(['once', 'repeated'])
})

test('a range purge still scopes summaries by occurred_at, not by last use', () => {
  expect(scopeFor({ kind: 'range', after: 0, before: 1 }).where.summaries).not.toContain('last_seen_at')
  // The range holds the repeat's prompt (its last use) but not the summary's first write.
  const result = purge(temp.store.db, { kind: 'range', after: NOW - 2 * DAY_MS, before: NOW }, { dryRun: false, now: () => NOW })
  expect(result.counts.summaries).toBe(0)
  expect(result.counts.prompts).toBe(1)
  expect(temp.store.db.query("SELECT repeat_count AS count, last_seen_at AS seen FROM summaries WHERE request = 'repeated'").get())
    .toEqual({ count: 1, seen: NOW - 10 * DAY_MS })
  expect(purge(temp.store.db, { kind: 'range', after: NOW - 11 * DAY_MS, before: NOW - 9 * DAY_MS }, { dryRun: false, now: () => NOW }).counts.summaries).toBe(2)
})
