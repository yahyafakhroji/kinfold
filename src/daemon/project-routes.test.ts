import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { type TempStore, openTempStore } from '../observer/test-support'
import { registerProject } from '../store/project-merge'
import { upsertSession } from '../store/writes'
import { DEVICE_REFUSAL, projectRoute } from './project-routes'

const T0 = 1_792_900_000_000
let temp: TempStore
let logs: string[]
beforeEach(() => {
  temp = openTempStore('kinfold-project-routes-')
  logs = []
  for (const key of ['/Users/me/rea', 'github.com/me/kinfold']) {
    registerProject(temp.store.db, { key, kind: key.startsWith('/') ? 'path' : 'git-remote', displayName: key.split('/').at(-1)! }, T0)
    const session = upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: key, projectKey: key, cwd: key, occurredAt: T0 })
    seedObservation(temp.store, { sessionId: session, projectKey: key, host: 'claude-code', title: `note in ${key}`, at: T0 })
  }
})
afterEach(() => temp.cleanup())

const deps = (device = false) => ({ db: temp.store.db, now: () => T0 + 1, log: (line: string) => logs.push(line), device })
const body = (value: unknown) => async () => ({ ok: true as const, value })
const get = (path: string, device = false) => projectRoute('GET', new URL(`http://x${path}`), body(undefined), deps(device))
const post = (path: string, value: unknown, device = false) => projectRoute('POST', new URL(`http://x${path}`), body(value), deps(device))

test('GET /projects lists each key with its counts, and the merges of the last day', async () => {
  const answer = await get('/projects')
  expect(answer?.status).toBe(200)
  expect((answer!.body as { projects: { key: string; memories: number }[] }).projects.map((row) => [row.key, row.memories])).toEqual([['/Users/me/rea', 1], ['github.com/me/kinfold', 1]])
  expect((answer!.body as { merges: unknown[] }).merges).toEqual([])
})

test('a merge is a dry run unless it says otherwise, then it moves and is logged by counts only', async () => {
  const preview = await post('/projects/merge', { from: '/Users/me/rea', into: 'github.com/me/kinfold' })
  expect(preview).toMatchObject({ status: 200, body: { ok: true, dryRun: true, counts: { observations: 1, sessions: 1 } } })
  const done = await post('/projects/merge', { from: '/Users/me/rea', into: 'github.com/me/kinfold', dryRun: false })
  expect(done).toMatchObject({ status: 200, body: { ok: true, dryRun: false } })
  expect(logs).toEqual(['project merge reason=manual sessions=1 observations=1'])
  expect(logs.join('\n')).not.toContain('/Users/me')
  expect(logs.join('\n')).not.toContain('kinfold')
  const split = await post('/projects/split', { key: '/Users/me/rea', dryRun: false })
  expect(split).toMatchObject({ status: 200, body: { ok: true, dryRun: false } })
})

test('a bad body or an unknown key is refused with the reason, and nothing moves', async () => {
  expect(await post('/projects/merge', { from: 'x' })).toMatchObject({ status: 400 })
  expect(await post('/projects/merge', { from: '/nope', into: 'github.com/me/kinfold', dryRun: false })).toMatchObject({ status: 409, body: { ok: false } })
  expect(await post('/projects/split', { key: 'github.com/me/kinfold' })).toMatchObject({ status: 409 })
  expect(await projectRoute('DELETE', new URL('http://x/projects'), body(undefined), deps())).toMatchObject({ status: 405 })
})

test('a central device sends every project command to the hub', async () => {
  expect(await get('/projects', true)).toEqual({ status: 409, body: { error: DEVICE_REFUSAL } })
  expect(await post('/projects/merge', { from: '/Users/me/rea', into: 'github.com/me/kinfold', dryRun: false }, true)).toEqual({ status: 409, body: { error: DEVICE_REFUSAL } })
})

test('other paths are not this route', async () => {
  expect(await get('/projectsx')).toBeNull()
})
