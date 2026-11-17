import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordInjection } from '../store/context-store'
import { type Store, openStore } from '../store/db'
import { upsertProject, upsertSession } from '../store/writes'
import { type HostTurn, estimateSaved, measureSaving, savedFor, savedTotals } from './saved'

const turns = (host: string, heldOut: boolean, values: readonly number[], projectKey = 'p'): HostTurn[] =>
  values.map((tokens) => ({ host, projectKey, heldOut, tokens }))
const around = (center: number, n: number, wobble: number): number[] => Array.from({ length: n }, (_, i) => center + ((i * 7919) % (2 * wobble + 1)) - wobble)

test('below 30 turns in either group there is no measured figure', () => {
  const result = measureSaving([...turns('claude-code', true, around(1000, 29, 10)), ...turns('claude-code', false, around(800, 40, 10))])
  expect(result.get('claude-code')).toEqual({ status: 'not-enough', heldOut: 29, normal: 40, minSample: 30 })
})

test('a clear gap is a saving per turn: held-out turns cost more', () => {
  const result = measureSaving([...turns('claude-code', true, around(1000, 40, 20)), ...turns('claude-code', false, around(800, 40, 20))])
  const measured = result.get('claude-code')
  expect(measured).toMatchObject({ status: 'saving', heldOut: 40, normal: 40 })
  if (measured?.status !== 'saving') throw new Error('expected a saving')
  expect(measured.perTurn).toBe(200)
  expect(measured.low).toBeGreaterThan(0)
  expect(measured.high).toBeGreaterThanOrEqual(measured.perTurn)
})

test('memory that makes turns bigger is reported as a cost, and noise as no measurable saving', () => {
  const cost = measureSaving([...turns('claude-code', true, around(700, 40, 20)), ...turns('claude-code', false, around(900, 40, 20))]).get('claude-code')
  expect(cost).toMatchObject({ status: 'cost', perTurn: -200 })
  const noise = measureSaving([...turns('claude-code', true, around(800, 40, 400)), ...turns('claude-code', false, around(805, 40, 400))]).get('claude-code')
  expect(noise).toMatchObject({ status: 'no-difference' })
})

test('the interval is the same on every run, so a report does not flicker', () => {
  const rows = [...turns('claude-code', true, around(1000, 40, 300)), ...turns('claude-code', false, around(900, 40, 300))]
  expect(measureSaving(rows).get('claude-code')).toEqual(measureSaving(rows).get('claude-code'))
})

test('projects with only one kind of turn are left out of the comparison', () => {
  const rows = [...turns('claude-code', true, around(1000, 40, 5), 'a'), ...turns('claude-code', false, around(800, 40, 5), 'b')]
  expect(measureSaving(rows).get('claude-code')).toMatchObject({ status: 'not-enough', heldOut: 0, normal: 0 })
})

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-saved-'))
  store = openStore(join(root, 'data'))
  upsertProject(store.db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, 1)
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

function run(id: number, tokens: number | null): void {
  store.db.run(`INSERT INTO observer_runs (id, session_id, host, provider, model, status, event_count, started_at, input_tokens, output_tokens)
    VALUES (${id}, 1, 'claude-code', 'claude-cli', 'm', 'succeeded', 1, 1, ${tokens === null ? 'NULL' : tokens - 100}, ${tokens === null ? 'NULL' : 100})`)
}
function memory(id: number, runId: number | null): void {
  store.db.run(`INSERT INTO observations (id, project_key, host, type, title, evidence, content_hash, occurred_at, created_at, observer_run_id)
    VALUES (${id}, 'org/repo', 'claude-code', 'discovery', 't', 'tool-verified', 'h${id}', 1, 1, ${runId ?? 'NULL'})`)
}
function session(hostSessionId: string): number {
  return upsertSession(store.db, { host: 'claude-code', hostSessionId, projectKey: 'org/repo', cwd: '/w', occurredAt: 1 })
}
function give(sessionId: number, hostSessionId: string, ids: number[], tokens: number): void {
  recordInjection(store.db, { sessionId, host: 'claude-code', hostSessionId, projectKey: 'org/repo', observationIds: ids, channel: 'session_start', tokens, occurredAt: 5 })
}

test('the estimate is what the observer spent making the memories a session got, less what reading them cost', () => {
  const one = session('s1')
  run(1, 3000)
  run(2, 1000)
  memory(1, 1)
  memory(2, 1)
  memory(3, 2)
  // Run 1 made two memories, so each carries 1,500 tokens; the session got memories 1 and 3 twice (counted once).
  give(one, 's1', [1, 3], 200)
  give(one, 's1', [1], 100)
  expect(estimateSaved(store.db, [one]).get(one)).toEqual({ tokens: 1500 + 1000 - 300, partial: false, memories: 2 })
})

test('a memory with no known run makes the estimate partial; nothing given is no estimate', () => {
  const one = session('s1')
  const two = session('s2')
  run(1, null)
  memory(1, 1)
  memory(2, null)
  give(one, 's1', [1, 2], 50)
  expect(estimateSaved(store.db, [one, two])).toEqual(new Map([[one, { tokens: 0, partial: true, memories: 2 }], [two, { tokens: 0, partial: false, memories: 0 }]]))
})

test('a measured result for the agent wins over the estimate, even when it finds no saving', () => {
  const measured = measureSaving([...turns('claude-code', true, around(1000, 40, 20)), ...turns('claude-code', false, around(800, 40, 20))])
  expect(savedFor({ host: 'claude-code', prompts: 3 }, measured, { tokens: 99, partial: false, memories: 1 })).toEqual({ kind: 'measured', status: 'saving', tokens: 600, turnsCompared: 80 })
  expect(savedFor({ host: 'codex', prompts: 3 }, measured, { tokens: 99, partial: true, memories: 1 })).toEqual({ kind: 'estimate', tokens: 99, partial: true })
  expect(savedFor({ host: 'codex', prompts: 3 }, measured, { tokens: 0, partial: false, memories: 0 })).toEqual({ kind: 'none' })
  const noise = measureSaving([...turns('codex', true, around(800, 40, 400)), ...turns('codex', false, around(805, 40, 400))])
  expect(savedFor({ host: 'codex', prompts: 3 }, noise, { tokens: 99, partial: false, memories: 1 })).toEqual({ kind: 'measured', status: 'no-difference', tokens: null, turnsCompared: 80 })
})

test('totals keep the two kinds apart', () => {
  expect(savedTotals([
    { kind: 'measured', status: 'saving', tokens: 600, turnsCompared: 80 },
    { kind: 'measured', status: 'saving', tokens: 400, turnsCompared: 80 },
    { kind: 'estimate', tokens: 50, partial: true },
    { kind: 'none' },
  ])).toEqual({ measured: { tokens: 1000, sessions: 2 }, estimate: { tokens: 50, sessions: 1, partial: true } })
})
