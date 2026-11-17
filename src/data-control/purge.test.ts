import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { T0 } from '../observer/test-support'
import { readPack } from '../store/context-store'
import { insertFinding } from '../store/findings-store'
import { DAY, type Fixture, MARKERS, count, ftsMatch, seedFixture, tableCounts } from './test-support'
import { describePurge, purge } from './purge'
import { recordActivity } from '../store/activity-store'

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

/** One turn_usage row per prompt in the fixture, at the prompt's own time. */
function seedTurnUsage(): void {
  fx.temp.store.db.run(`INSERT INTO turn_usage (session_id, prompt_number, host, project_key, held_out, input_tokens, output_tokens, cache_read_tokens,
      cache_creation_tokens, tool_calls, duration_ms, occurred_at)
    SELECT p.session_id, p.prompt_number, s.host, s.project_key, 0, 1, 1, 0, 0, 0, NULL, p.occurred_at FROM prompts p JOIN sessions s ON s.id = p.session_id`)
}
const turnUsage = (): { sessionId: number; promptNumber: number }[] =>
  fx.temp.store.db.query<{ sessionId: number; promptNumber: number }, []>('SELECT session_id AS sessionId, prompt_number AS promptNumber FROM turn_usage ORDER BY 1, 2').all()

test('turn usage goes with the prompt it measured: by prompt, by session and by range, and the dry run counts it', () => {
  seedTurnUsage()
  const prompts = fx.temp.store.db.query<{ id: number; sessionId: number; promptNumber: number }, []>(
    'SELECT id, session_id AS sessionId, prompt_number AS promptNumber FROM prompts ORDER BY id').all()
  expect(turnUsage()).toHaveLength(prompts.length)
  const [first] = prompts
  expect(run({ kind: 'prompt', id: first!.id }, true).counts.turn_usage).toBe(1)
  expect(run({ kind: 'prompt', id: first!.id }).counts.turn_usage).toBe(1)
  expect(turnUsage()).not.toContainEqual({ sessionId: first!.sessionId, promptNumber: first!.promptNumber })
  const ofA2 = turnUsage().filter((row) => row.sessionId === fx.sessions.a2).length
  expect(ofA2).toBeGreaterThan(0)
  expect(run({ kind: 'session', id: fx.sessions.a2 }).counts.turn_usage).toBe(ofA2)
  expect(turnUsage().some((row) => row.sessionId === fx.sessions.a2)).toBe(false)
  run({ kind: 'range', after: null, before: T0 + 100 * DAY })
  expect(turnUsage()).toEqual([])
})

test('activity rows that name a purged project, session or host go with it, and a range takes the rows inside it', () => {
  const { db } = fx.temp.store
  const rows = (): string[] => (db.query('SELECT kind || \':\' || coalesce(project_key, \'-\') || \':\' || coalesce(session_id, 0) AS row FROM activity ORDER BY id').all() as { row: string }[]).map((entry) => entry.row)
  db.run('DELETE FROM activity')
  recordActivity(db, { kind: 'save', at: T0, projectKey: fx.projectA, sessionId: fx.sessions.a1, host: 'claude-code', count: 1 })
  recordActivity(db, { kind: 'save', at: T0, projectKey: fx.projectB, sessionId: fx.sessions.b1, host: 'claude-code', count: 1 })
  recordActivity(db, { kind: 'backup', at: T0 })
  const dry = purge(db, { kind: 'project', key: fx.projectA }, { dryRun: true, now: () => T0 })
  expect(dry.counts.activity).toBe(1)
  purge(db, { kind: 'project', key: fx.projectA }, { dryRun: false, now: () => T0 })
  expect(rows()).toEqual([`save:${fx.projectB}:${fx.sessions.b1}`, 'backup:-:0'])
  purge(db, { kind: 'session', id: fx.sessions.b1 }, { dryRun: false, now: () => T0 })
  expect(rows()).toEqual(['backup:-:0'])
  purge(db, { kind: 'range', after: null, before: T0 + 1 }, { dryRun: false, now: () => T0 })
  expect(rows()).toEqual([])
})
