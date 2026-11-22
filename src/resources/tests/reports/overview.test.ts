import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordInjection } from '../../store/context-store'
import { type Store, openStore } from '../../store/db'
import { insertPrompt, upsertProject, upsertSession } from '../../store/writes'
import { impactReport, overviewReport } from '../../reports/overview'

const DAY = 86_400_000
const NOW = 100 * DAY
let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-overview-'))
  store = openStore(join(root, 'data'))
  upsertProject(store.db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, 1)
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

function run(id: number, host: string, status: string, error: string | null, at: number): void {
  store.db.query(`INSERT INTO observer_runs (id, session_id, host, provider, model, status, error, event_count, started_at, finished_at, input_tokens, output_tokens)
    VALUES ($id, 1, $host, 'claude-cli', 'm', $status, $error, 1, $at, $at, 900, 100)`).run({ id, host, status, error, at })
}

test('the overview counts memory, this week\'s prompts and which got memory, and names agents whose summaries fail', () => {
  const old = upsertSession(store.db, { host: 'claude-code', hostSessionId: 'old', projectKey: 'org/repo', cwd: '/w', occurredAt: NOW - 30 * DAY })
  insertPrompt(store.db, { sessionId: old, promptNumber: 1, text: 'p', occurredAt: NOW - 30 * DAY })
  const recent = upsertSession(store.db, { host: 'claude-code', hostSessionId: 'new', projectKey: 'org/repo', cwd: '/w', occurredAt: NOW - DAY })
  for (const n of [1, 2, 3]) insertPrompt(store.db, { sessionId: recent, promptNumber: n, text: 'p', occurredAt: NOW - DAY + n })
  run(1, 'claude-code', 'succeeded', null, NOW - 2 * DAY)
  run(2, 'codex', 'succeeded', null, NOW - 3 * DAY)
  run(3, 'codex', 'failed', 'timeout: after 120 s', NOW - 2 * DAY)
  store.db.run(`INSERT INTO observations (id, project_key, session_id, host, type, title, evidence, content_hash, occurred_at, created_at, observer_run_id)
    VALUES (1, 'org/repo', ${old}, 'claude-code', 'discovery', 't', 'tool-verified', 'h1', 1, 1, 1)`)
  recordInjection(store.db, { sessionId: recent, host: 'claude-code', hostSessionId: 'new', projectKey: 'org/repo', observationIds: [1], channel: 'prompt', tokens: 40, occurredAt: NOW - DAY + 1, promptNumber: 1 })
  const report = overviewReport(store.db, NOW, [])
  expect(report).toMatchObject({
    memories: 1, projects: 1, sessions: 2,
    week: { sessions: 1, prompts: 3, promptsWithMemory: 1 },
    failing: [{ host: 'codex', provider: 'claude-cli', errorClass: 'timeout', at: NOW - 2 * DAY }],
  })
  // Run 1 made one memory with 1,000 tokens; the session read it in 40.
  expect(report.saved).toEqual({ measured: { tokens: 0, sessions: 0 }, estimate: { tokens: 960, sessions: 1, partial: false } })
  expect(report.recordsSince).toBeGreaterThan(0)
})

test('an error that is not a known class reads as other, so no free text leaves the store', () => {
  upsertSession(store.db, { host: 'codex', hostSessionId: 's', projectKey: 'org/repo', cwd: '/w', occurredAt: 1 })
  run(1, 'codex', 'failed', 'something odd happened with /Users/me/secret', NOW - DAY)
  expect(overviewReport(store.db, NOW, []).failing).toEqual([expect.objectContaining({ errorClass: 'other' })])
})

test('impact holds the measured result per agent beside the estimate totals, and the existing costs', () => {
  const report = impactReport(store.db, NOW, '7d', [])
  expect(report.window).toBe('7d')
  expect(report.measured).toEqual([])
  expect(report.saved).toEqual({ measured: { tokens: 0, sessions: 0 }, estimate: { tokens: 0, sessions: 0, partial: false } })
  expect(report.holdout.on).toBe(false)
  expect(Array.isArray(report.context)).toBe(true)
})

test('a stored error with no colon keeps its whole class name: "timeout" is timeout, not a name cut one letter short', () => {
  upsertSession(store.db, { host: 'codex', hostSessionId: 's', projectKey: 'org/repo', cwd: '/w', occurredAt: 1 })
  upsertSession(store.db, { host: 'cursor', hostSessionId: 'c', projectKey: 'org/repo', cwd: '/w', occurredAt: 1 })
  run(1, 'codex', 'failed', 'timeout', NOW - DAY)
  run(2, 'cursor', 'failed', ' timeout : after 120 s', NOW - DAY)
  expect(overviewReport(store.db, NOW, []).failing.map((agent) => [agent.host, agent.errorClass])).toEqual([['codex', 'timeout'], ['cursor', 'timeout']])
})
