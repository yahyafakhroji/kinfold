// A store request that was already running when a restore closed the store
// fails on the closed connection. It answers 503 with a retry hint, as a
// request that arrives while the store is closed does, and not 500.

import { expect, test } from 'bun:test'
import { createDashboardAuth } from '../dashboard/auth'
import { type ServerDeps, handleRequest } from './server'

const PORT = 37_998
const TOKEN = 'b'.repeat(64)
const RESTORING = 'Kinfold is restoring a backup; try again in a moment'

function rig(listSessions: () => unknown[], unavailable: () => string | null) {
  const logs: string[] = []
  const deps = { port: PORT, token: TOKEN, auth: createDashboardAuth(), log: (line: string) => logs.push(line), listSessions, unavailable } as unknown as ServerDeps
  const get = (path: string): Promise<Response> =>
    handleRequest(new Request(`http://127.0.0.1:${PORT}${path}`, { headers: { host: `127.0.0.1:${PORT}`, authorization: `Bearer ${TOKEN}` } }), PORT, deps)
  return { get, logs }
}

test('a request caught by the store closing answers 503 with Retry-After, like one that arrives while it is closed', async () => {
  let down: string | null = null
  const { get } = rig(() => {
    down = RESTORING
    throw new Error('database is closed')
  }, () => down)
  const caught = await get('/sessions')
  expect(caught.status).toBe(503)
  expect(caught.headers.get('retry-after')).toBe('1')
  expect(await caught.json()).toEqual({ error: RESTORING })
  const closed = await get('/sessions')
  expect(closed.status).toBe(503)
  expect(closed.headers.get('retry-after')).toBe('1')
})

test('a failure while the store is open is not dressed up as a restore', async () => {
  const { get } = rig(() => {
    throw new Error('boom')
  }, () => null)
  await expect(get('/sessions')).rejects.toThrow('boom')
})
