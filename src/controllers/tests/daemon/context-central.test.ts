// A hub answering a device: the project key comes from the device (the hub
// runs no git in a device's folder) and the hub's own update notice is never
// handed out, since it is about the hub's program, not the device's.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../../../resources/tests/context/test-support'
import type { ContextRequest } from '../../../resources/context/types'
import { type TempStore, T0, openTempStore } from '../../../resources/tests/observer/test-support'
import { upsertProject, upsertSession } from '../../../resources/store/writes'
import { contextHandler } from '../../daemon/context-route'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-context-central-')
  upsertProject(temp.store.db, { key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }, T0)
  const session = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc-1', projectKey: 'github.com/acme/app', cwd: '/mini/app', occurredAt: T0 })
  seedObservation(temp.store, { sessionId: session, projectKey: 'github.com/acme/app', host: 'opencode', title: 'Shared across devices', at: T0 })
})
afterEach(() => temp.cleanup())

const request: ContextRequest = { host: 'claude-code', cwd: '/laptop/elsewhere/app', hostSessionId: 'cc-9', channel: 'session_start' }

test('a central request uses the key it carries and never runs the resolver', async () => {
  let resolved = 0
  const handler = contextHandler({ db: temp.store.db, projectKeyFor: () => { resolved += 1; return { key: 'wrong', kind: 'path', displayName: 'wrong' } }, log: () => {}, now: () => T0 + 1 })
  const answer = await handler(request, { projectKey: 'github.com/acme/app' })
  expect(answer.text).toContain('Shared across devices')
  expect(resolved).toBe(0)
})

test('a central request takes no update notice, so the hub\'s own sessions still get theirs', async () => {
  let asked = 0
  const handler = contextHandler({
    db: temp.store.db, projectKeyFor: () => ({ key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }), log: () => {}, now: () => T0 + 1,
    updates: { dataDir: temp.dataDir, version: '0.6.0', envVars: () => { asked += 1; return {} } },
  })
  const answer = await handler(request, { projectKey: 'github.com/acme/app' })
  expect(answer.updateNotice).toBeUndefined()
  expect(asked).toBe(0)
  await handler(request)
  expect(asked).toBe(1)
})

test('a central ask carries the device\'s remaining wait: an answer past it is recorded late, so it is offered again', async () => {
  let ticks = 0
  // Each reading of the clock moves 40 ms on: the answer takes far longer than 60 ms, far less than the hook's own 180.
  const clock = (): number => (ticks += 40)
  const handler = contextHandler({ db: temp.store.db, projectKeyFor: () => ({ key: 'github.com/acme/app', kind: 'git-remote', displayName: 'app' }), log: () => {}, now: () => T0 + 1, clock })
  const prompt = { ...request, channel: 'prompt' as const, prompt: 'shared across devices' }
  await handler(prompt, { projectKey: 'github.com/acme/app', budgetMs: 60 })
  await handler({ ...prompt, hostSessionId: 'cc-10' }, { projectKey: 'github.com/acme/app' })
  const late = temp.store.db.query('SELECT host_session_id AS session, late FROM injections ORDER BY id').all()
  expect(late).toEqual([{ session: 'cc-9', late: 1 }, { session: 'cc-10', late: 0 }])
})
