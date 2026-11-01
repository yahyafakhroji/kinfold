import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { T0 } from '../observer/test-support'
import { readPack } from '../store/context-store'
import { insertFinding } from '../store/findings-store'
import { DAY, type Fixture, MARKERS, count, ftsMatch, seedFixture, tableCounts } from './test-support'
import { describePurge, purge } from './purge'

let fx: Fixture
beforeEach(() => {
  fx = seedFixture('sam-purge-')
})
afterEach(() => fx.temp.cleanup())

const run = (target: Parameters<typeof purge>[1], dryRun = false) => purge(fx.temp.store.db, target, { dryRun, now: () => T0 + 10 * DAY })
const titles = (): string[] => fx.temp.store.db.query<{ title: string }, []>('SELECT title FROM observations ORDER BY id').all().map((row) => row.title)
const fileBytes = (): Buffer => Buffer.concat([fx.temp.store.path, `${fx.temp.store.path}-wal`].filter(existsSync).map((path) => readFileSync(path)))

test('a dry run reports the counts a real run removes, and changes nothing', () => {
  const before = tableCounts(fx.temp)
  const dry = run({ kind: 'session', id: fx.sessions.a1 }, true)
  expect(tableCounts(fx.temp)).toEqual(before)
  expect(dry.scrub).toBeNull()
  const real = run({ kind: 'session', id: fx.sessions.a1 })
  expect(real.counts).toEqual(dry.counts)
  expect(dry.counts).toMatchObject({ sessions: 1, events: 1, prompts: 1, observations: 1, summaries: 1, injections: 1, injectionsTrimmed: 1, projects: 0 })
})

test('purge by observation id removes it from the table, FTS and the packs, and trims or drops injections', () => {
  expect(ftsMatch(fx.temp, MARKERS.a1)).toEqual([fx.observations.a1])
  const report = run({ kind: 'observation', id: fx.observations.a1 })
  expect(report.counts).toMatchObject({ observations: 1, sessions: 0, events: 0, injections: 1, injectionsTrimmed: 1 })
  expect(ftsMatch(fx.temp, MARKERS.a1)).toEqual([])
  expect(ftsMatch(fx.temp, MARKERS.a2)).toEqual([fx.observations.a2])
  expect(report.packsRebuilt).toBe(3)
  const pack = readPack(fx.temp.store.db, fx.projectA, 'claude-code')!
  // The summary of that session stays (only the observation was named), so check the line, not the marker.
  expect(pack.body).not.toContain(`Observed ${MARKERS.a1}`)
  expect(pack.body).toContain(`Observed ${MARKERS.a2}`)
  expect(pack.observationIds).toEqual([fx.observations.a2])
  const injections = fx.temp.store.db.query<{ ids: string }, []>('SELECT observation_ids AS ids FROM injections').all()
  expect(injections).toEqual([{ ids: `[${fx.observations.a2}]` }])
})

test('purge by session takes its events, prompts, observations, summary and injections, and nothing of the others', () => {
  run({ kind: 'session', id: fx.sessions.a1 })
  expect(titles()).toEqual([`Observed ${MARKERS.a2} works`, `Observed ${MARKERS.b1} works`])
  expect(count(fx.temp, 'sessions')).toBe(2)
  expect(count(fx.temp, 'summaries')).toBe(0)
  expect(count(fx.temp, 'prompts')).toBe(2)
  expect(readPack(fx.temp.store.db, fx.projectA, 'default')!.body).not.toContain(`next for ${MARKERS.a1}`)
})

test('purge by project deletes the project row, its sessions and packs, and leaves the other project whole', () => {
  const report = run({ kind: 'project', key: fx.projectA })
  expect(report.counts).toMatchObject({ projects: 1, sessions: 2, observations: 2, context_packs: 3 })
  expect(titles()).toEqual([`Observed ${MARKERS.b1} works`])
  expect(fx.temp.store.db.query('SELECT key FROM projects').all()).toEqual([{ key: fx.projectB }])
  expect(readPack(fx.temp.store.db, fx.projectB, 'claude-code')!.body).toContain(MARKERS.b1)
})

test('purge by host removes that host across projects', () => {
  run({ kind: 'host', host: 'claude-code' })
  expect(titles()).toEqual([`Observed ${MARKERS.a2} works`])
  expect(fx.temp.store.db.query('SELECT host FROM sessions').all()).toEqual([{ host: 'opencode' }])
})

test('purge by date range removes rows before the cutoff and whole sessions inside it', () => {
  const report = run({ kind: 'range', after: null, before: T0 + DAY })
  expect(report.counts).toMatchObject({ sessions: 1, observations: 1, events: 1 })
  expect(titles()).toEqual([`Observed ${MARKERS.a2} works`, `Observed ${MARKERS.b1} works`])
  const bounded = run({ kind: 'range', after: T0 + DAY, before: T0 + 2 * DAY })
  expect(bounded.counts).toMatchObject({ sessions: 1, observations: 1 })
  expect(titles()).toEqual([`Observed ${MARKERS.b1} works`])
})

test('findings on purged rows go with them', () => {
  insertFinding(fx.temp.store.db, { table: 'events', rowId: fx.events.a1, field: 'tool.output', rule: 'key_fragment', ruleVersion: 2, matches: 1, foundAt: T0 })
  insertFinding(fx.temp.store.db, { table: 'events', rowId: fx.events.b1, field: 'tool.output', rule: 'key_fragment', ruleVersion: 2, matches: 1, foundAt: T0 })
  expect(run({ kind: 'session', id: fx.sessions.a1 }).counts.findings).toBe(1)
  expect(fx.temp.store.db.query('SELECT row_id FROM redaction_findings').all()).toEqual([{ row_id: fx.events.b1 }])
})

test('after a purge and incremental vacuum the purged text is gone from the database file bytes', () => {
  fx.temp.store.db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  expect(fileBytes().includes(MARKERS.a1)).toBe(true)
  const report = run({ kind: 'session', id: fx.sessions.a1 })
  expect(report.scrub?.walTruncated).toBe(true)
  const bytes = fileBytes()
  expect(bytes.includes(MARKERS.a1)).toBe(false)
  expect(bytes.includes(MARKERS.b1)).toBe(true)
})

test('the log line carries the kind, ids and counts, never a project key or host', () => {
  const report = run({ kind: 'project', key: fx.projectA })
  const line = describePurge({ kind: 'project', key: fx.projectA }, report)
  expect(line).toStartWith('data purge target=project dry_run=false')
  expect(line).not.toContain(fx.projectA)
  expect(describePurge({ kind: 'host', host: 'opencode' }, run({ kind: 'host', host: 'opencode' }, true))).not.toContain('opencode')
})

test('a target that matches nothing removes nothing and skips the scrub', () => {
  const report = run({ kind: 'observation', id: 999 })
  expect(Object.values(report.counts).every((n) => n === 0)).toBe(true)
  expect(report.scrub).toBeNull()
  expect(report.packsRebuilt).toBe(0)
})
