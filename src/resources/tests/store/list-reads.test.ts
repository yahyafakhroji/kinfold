import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordInjection } from '../../store/context-store'
import { type Store, openStore } from '../../store/db'
import { devicesSeen, memoriesPage, projectsPage, sessionHeader, sessionsPage } from '../../store/list-reads'
import { insertPrompt, upsertProject, upsertSession } from '../../store/writes'

let root: string
let store: Store
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-lists-'))
  store = openStore(join(root, 'data'))
  upsertProject(store.db, { key: 'org/alpha', kind: 'git-remote', displayName: 'alpha' }, 1)
  upsertProject(store.db, { key: 'org/beta', kind: 'git-remote', displayName: 'beta' }, 1)
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

function session(hostSessionId: string, host: string, projectKey: string, at: number, prompts: number, device: string | null): number {
  const id = upsertSession(store.db, { host, hostSessionId, projectKey, cwd: '/w', occurredAt: at, device })
  for (let n = 1; n <= prompts; n += 1) insertPrompt(store.db, { sessionId: id, promptNumber: n, text: `p${n}`, occurredAt: at + n })
  return id
}
function memory(id: number, projectKey: string, title: string, at: number, sessionId: number | null, type = 'discovery'): void {
  store.db.query(`INSERT INTO observations (id, project_key, session_id, host, prompt_number, type, title, evidence, content_hash, occurred_at, created_at)
    VALUES ($id, $projectKey, $sessionId, 'claude-code', 1, $type, $title, 'tool-verified', $hash, $at, $at)`).run({ id, projectKey, sessionId, type, title, hash: `h${id}`, at })
}

const base = { page: 1, pageSize: 50, q: null, host: null, project: null, device: null }

test('sessions come back newest first with prompts, prompts that got memory and the device', () => {
  const one = session('s1', 'claude-code', 'org/alpha', 100, 3, 'local')
  const two = session('s2', 'codex', 'org/beta', 200, 1, 'dev-a')
  for (const promptNumber of [1, 2]) {
    recordInjection(store.db, { sessionId: one, host: 'claude-code', hostSessionId: 's1', projectKey: 'org/alpha', observationIds: [9], channel: 'prompt', tokens: 5, occurredAt: 150, promptNumber })
  }
  // A late answer was probably not shown, so that prompt did not get memory.
  recordInjection(store.db, { sessionId: one, host: 'claude-code', hostSessionId: 's1', projectKey: 'org/alpha', observationIds: [9], channel: 'prompt', tokens: 5, occurredAt: 150, promptNumber: 3, late: true })
  const page = sessionsPage(store.db, { ...base, sort: 'started', dir: 'desc' })
  expect(page.total).toBe(2)
  expect(page.rows).toEqual([
    { id: two, startedAt: 200, lastEventAt: 200, endedAt: null, host: 'codex', projectKey: 'org/beta', project: 'beta', device: 'dev-a', prompts: 1, promptsWithMemory: 0 },
    { id: one, startedAt: 100, lastEventAt: 100, endedAt: null, host: 'claude-code', projectKey: 'org/alpha', project: 'alpha', device: 'local', prompts: 3, promptsWithMemory: 2 },
  ])
})

test('sessions sort by any listed column, filter, search the project name and page', () => {
  session('s1', 'claude-code', 'org/alpha', 100, 3, 'local')
  session('s2', 'codex', 'org/beta', 200, 1, 'dev-a')
  session('s3', 'claude-code', 'org/beta', 300, 2, 'dev-a')
  const ids = (query: Partial<Parameters<typeof sessionsPage>[1]>): string[] => sessionsPage(store.db, { ...base, sort: 'started', dir: 'desc', ...query }).rows.map((row) => `${row.host}/${row.prompts}`)
  expect(ids({ sort: 'prompts', dir: 'desc' })).toEqual(['claude-code/3', 'claude-code/2', 'codex/1'])
  expect(ids({ sort: 'project', dir: 'asc' })).toEqual(['claude-code/3', 'claude-code/2', 'codex/1'])
  expect(ids({ sort: 'agent', dir: 'asc' })).toEqual(['claude-code/2', 'claude-code/3', 'codex/1'])
  expect(ids({ host: 'codex' })).toEqual(['codex/1'])
  expect(ids({ device: 'dev-a', project: 'org/beta' })).toEqual(['claude-code/2', 'codex/1'])
  expect(ids({ q: 'alp' })).toEqual(['claude-code/3'])
  const second = sessionsPage(store.db, { ...base, pageSize: 2, page: 2, sort: 'started', dir: 'desc' })
  expect([second.total, second.rows.length]).toEqual([3, 1])
})

test('memories sort by times recalled and age, filter by kind and device, and search by words', () => {
  const one = session('s1', 'claude-code', 'org/alpha', 100, 1, 'dev-a')
  memory(1, 'org/alpha', 'Bun is pinned', 10, one)
  memory(2, 'org/alpha', 'Tests run with bun test', 20, null, 'decision')
  memory(3, 'org/beta', 'Release builds are signed', 30, null)
  recordInjection(store.db, { sessionId: one, host: 'claude-code', hostSessionId: 's1', projectKey: 'org/alpha', observationIds: [1, 2], channel: 'session_start', tokens: 5, occurredAt: 50 })
  recordInjection(store.db, { sessionId: one, host: 'claude-code', hostSessionId: 's1', projectKey: 'org/alpha', observationIds: [1], channel: 'session_start', tokens: 5, occurredAt: 50 })
  const ids = (query: object): number[] => memoriesPage(store.db, { ...base, type: null, match: null, sort: 'age', dir: 'desc', ...query }).rows.map((row) => row.id)
  expect(ids({})).toEqual([3, 2, 1])
  expect(ids({ sort: 'recalls', dir: 'desc' })).toEqual([1, 2, 3])
  expect(ids({ sort: 'title', dir: 'asc' })).toEqual([1, 3, 2])
  expect(ids({ type: 'decision' })).toEqual([2])
  expect(ids({ device: 'dev-a' })).toEqual([1])
  expect(ids({ match: '"bun"' })).toEqual([2, 1])
  expect(memoriesPage(store.db, { ...base, type: null, match: null, sort: 'age', dir: 'desc' }).rows[2]).toEqual({
    id: 1, title: 'Bun is pinned', type: 'discovery', projectKey: 'org/alpha', project: 'alpha', host: 'claude-code', device: 'dev-a',
    sessionId: one, occurredAt: 10, recallCount: 2, contradicted: false,
  })
})

test('a session header carries what the list row does, plus the memories its start pack held', () => {
  const one = session('s1', 'claude-code', 'org/alpha', 100, 2, 'local')
  recordInjection(store.db, { sessionId: one, host: 'claude-code', hostSessionId: 's1', projectKey: 'org/alpha', observationIds: [4, 5], channel: 'session_start', tokens: 9, occurredAt: 101 })
  expect(sessionHeader(store.db, one)).toMatchObject({ id: one, prompts: 2, device: 'local', startMemories: 2, cwd: '/w' })
  expect(sessionHeader(store.db, 999)).toBeNull()
})

test('projects list memories and sessions per project; devices list what each machine captured', () => {
  const one = session('s1', 'claude-code', 'org/alpha', 100, 1, 'dev-a')
  session('s2', 'codex', 'org/alpha', 400, 1, 'local')
  memory(1, 'org/alpha', 'one', 10, one)
  const projects = projectsPage(store.db, { page: 1, pageSize: 50, q: null, sort: 'memories', dir: 'desc' })
  expect(projects.rows).toEqual([
    { key: 'org/alpha', name: 'alpha', memories: 1, sessions: 2, lastActiveAt: 400 },
    { key: 'org/beta', name: 'beta', memories: 0, sessions: 0, lastActiveAt: null },
  ])
  expect(devicesSeen(store.db)).toEqual([{ device: 'local', sessions: 1, lastSeenAt: 400 }, { device: 'dev-a', sessions: 1, lastSeenAt: 100 }])
})
