import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { recordActivity } from '../store/activity-store'
import { recordInjection } from '../store/context-store'
import { openStore } from '../store/db'
import { insertPrompt, upsertProject, upsertSession } from '../store/writes'

let root: string
let rig: DashboardRig
let sessionId: number

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-dashboard-api-'))
  const dataDir = join(root, 'data')
  const store = openStore(dataDir)
  upsertProject(store.db, { key: 'org/alpha', kind: 'git-remote', displayName: 'alpha' }, 1)
  sessionId = upsertSession(store.db, { host: 'claude-code', hostSessionId: 's1', projectKey: 'org/alpha', cwd: '/w', occurredAt: 1_000, device: 'local' })
  insertPrompt(store.db, { sessionId, promptNumber: 1, text: 'hello', occurredAt: 1_001 })
  for (let id = 1; id <= 60; id += 1) {
    store.db.run(`INSERT INTO observations (id, project_key, session_id, host, type, title, evidence, content_hash, occurred_at, created_at)
      VALUES (${id}, 'org/alpha', ${sessionId}, 'claude-code', 'discovery', 'Note ${id}', 'tool-verified', 'h${id}', ${id}, ${id})`)
  }
  recordInjection(store.db, { sessionId, host: 'claude-code', hostSessionId: 's1', projectKey: 'org/alpha', observationIds: [7], channel: 'prompt', tokens: 5, occurredAt: 1_002, promptNumber: 1 })
  recordActivity(store.db, { kind: 'backup', at: 2_000 })
  store.db.close()
  rig = startRig(dataDir)
})
afterEach(async () => {
  await rig.stop()
  rmSync(root, { recursive: true, force: true })
})

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await rig.bearer('GET', path)
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

test('the sessions list answers a page with saved figures and the paging fields', async () => {
  const { status, body } = await get('/memory/list/sessions')
  expect(status).toBe(200)
  expect(body).toMatchObject({ total: 1, page: 1, pageSize: 50, sort: 'started', dir: 'desc' })
  expect((body.rows as unknown[])[0]).toMatchObject({ id: sessionId, project: 'alpha', device: 'local', prompts: 1, promptsWithMemory: 1, saved: { kind: 'estimate', partial: true } })
})

test('the memories list pages by 50, sorts by times recalled and searches', async () => {
  const first = await get('/memory/list/memories?sort=recalls&dir=desc')
  expect(first.body).toMatchObject({ total: 60, page: 1, pageSize: 50 })
  expect((first.body.rows as { id: number; recallCount: number }[])[0]).toMatchObject({ id: 7, recallCount: 1 })
  expect(((await get('/memory/list/memories?page=2')).body.rows as unknown[]).length).toBe(10)
  expect((await get('/memory/list/memories?q=Note')).body.total).toBe(60)
})

test('bad paging, an unknown sort or parameter is refused by name, never echoed', async () => {
  for (const path of ['/memory/list/activity?dir=asc', '/memory/list/sessions?page=0', '/memory/list/sessions?sort=secret', '/memory/list/sessions?dir=up', '/memory/list/memories?nope=1', '/memory/impact?window=1y']) {
    const { status, body } = await get(path)
    expect([path, status]).toEqual([path, 400])
    expect(JSON.stringify(body)).not.toContain('secret')
  }
})

test('activity, projects and devices lists answer', async () => {
  const activity = await get('/memory/list/activity?kind=backup')
  expect(activity.body).toMatchObject({ total: 1, rows: [expect.objectContaining({ kind: 'backup', at: 2_000 })] })
  expect((await get('/memory/list/activity')).body.total).toBe(2)
  expect((await get('/memory/list/projects')).body).toMatchObject({ total: 1, rows: [expect.objectContaining({ key: 'org/alpha', memories: 60, sessions: 1 })] })
  expect((await get('/memory/list/devices')).body).toEqual({ rows: [{ device: 'local', name: null, sessions: 1, lastSeenAt: 1_000 }] })
})

test('a session header carries its saved box; an unknown one is 404', async () => {
  expect(await get(`/memory/sessions/${sessionId}`)).toMatchObject({ status: 200, body: { id: sessionId, prompts: 1, saved: { kind: 'estimate' } } })
  expect((await get('/memory/sessions/999')).status).toBe(404)
})

test('a memory detail says how often it was recalled', async () => {
  expect((await get('/memory/observations/7')).body).toMatchObject({ id: 7, recallCount: 1, sessionId })
})

test('overview and impact are kept reports with an as-of time', async () => {
  const overview = await get('/memory/overview')
  expect(overview.body).toMatchObject({ refreshing: false, value: { memories: 60, sessions: 1 } })
  expect(typeof overview.body.asOf).toBe('number')
  const impact = await get('/memory/impact?window=30d')
  expect(impact.body).toMatchObject({ value: { window: '30d', measured: [] } })
})
