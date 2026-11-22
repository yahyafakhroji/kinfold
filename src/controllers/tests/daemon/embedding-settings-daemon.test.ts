// /embedding/settings on a running daemon: the token and the dashboard cookie
// both reach it, and a saved change restarts the core onto the new embedder.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { fakeEmbedder } from '../../../resources/tests/vectors/test-support'

let root: string
let rig: DashboardRig
let built: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kf-embed-settings-'))
  built = []
  rig = startRig(join(root, 'data'), {
    vectors: {
      embedders: (db) => {
        const row = db.query<{ provider: string }, []>('SELECT provider FROM embedding_settings').get()
        built.push(row?.provider ?? 'none')
        return { target: fakeEmbedder(`fake-${row?.provider ?? 'none'}`), others: [], reason: '' }
      },
    },
  })
})
afterEach(async () => {
  await rig.stop()
  rmSync(root, { recursive: true, force: true })
})

test('the token reads the settings and the space status', async () => {
  const response = await rig.bearer('GET', '/embedding/settings')
  expect(response.status).toBe(200)
  const body = (await response.json()) as { active: { model: string } | null; building: unknown }
  expect(body.active?.model).toBe('fake-none')
  expect(body.building).toBeNull()
})

test('a saved change restarts the core onto the new settings', async () => {
  const cookie = await rig.login()
  const response = await rig.page('PUT', '/embedding/settings', { cookie, body: { provider: 'openrouter' } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ saved: { provider: 'openrouter' }, restarting: true })
  // The route answers 503 while the core restarts.
  // Whether the new core was up is read before each request: an answer asked before the restart is the old core's.
  let rebuilt = built.includes('openrouter')
  let answer = await rig.bearer('GET', '/embedding/settings')
  for (let i = 0; i < 100 && !(rebuilt && answer.status === 200); i += 1) {
    await Bun.sleep(20)
    rebuilt = built.includes('openrouter')
    answer = await rig.bearer('GET', '/embedding/settings')
  }
  expect(built).toEqual(['none', 'openrouter'])
  const after = (await answer.json()) as { settings: { provider: string }; active: { model: string } | null; building: unknown }
  expect(after.settings.provider).toBe('openrouter')
  // An empty store has nothing to build, so the new space is active at once.
  expect(after.active?.model).toBe('fake-openrouter')
  expect(after.building).toBeNull()
})

test('two quick changes restart the core once per change, one after the other, and leave one core', async () => {
  const cookie = await rig.login()
  const [first, second] = await Promise.all([
    rig.page('PUT', '/embedding/settings', { cookie, body: { provider: 'openrouter' } }),
    rig.page('PUT', '/embedding/settings', { cookie, body: { provider: 'local' } }),
  ])
  expect([first.status, second.status]).toEqual([200, 200])
  let answer = await rig.bearer('GET', '/embedding/settings')
  for (let i = 0; i < 150 && !(built.length >= 2 && answer.status === 200 && rig.logs.filter((line) => line.includes('restarting the store core')).length >= 1); i += 1) {
    await Bun.sleep(20)
    answer = await rig.bearer('GET', '/embedding/settings')
  }
  await Bun.sleep(200)
  // Each restart builds one core; none runs beside another.
  expect(rig.logs.filter((line) => line.includes('embedding restart failed'))).toEqual([])
  expect(built.at(-1)).toBe('local')
  expect(built.length).toBeLessThanOrEqual(3)
  expect(rig.logs.filter((line) => line.includes('restarting the store core')).length).toBe(built.length - 1)
})

test('without a credential the route is refused', async () => {
  const response = await fetch(rig.url('/embedding/settings'))
  expect(response.status).toBe(401)
})
