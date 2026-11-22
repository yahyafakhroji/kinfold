// The heartbeat of `kinfold dashboard` comes every second and the page's
// open-or-closed check every five; if either counted as someone at work, an
// automatic update would wait for as long as a dashboard runs.

import { expect, test } from 'bun:test'
import { type ServerDeps, handleRequest } from '../daemon/server'
import { createDashboardAuth, sessionCookie } from './auth'

const PORT = 37_997
const TOKEN = 'c'.repeat(64)
const LEASE = 'L'.repeat(43)

test('lease renewals and the page state check are not activity; a page request still is', async () => {
  const auth = createDashboardAuth()
  auth.holdLease(LEASE, 'live')
  const secret = auth.redeemCode(auth.issueCode(LEASE)!.code)!
  let activity = 0
  const deps = { port: PORT, token: TOKEN, auth, log: () => {}, onActivity: () => { activity += 1 } } as unknown as ServerDeps
  const send = (method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> =>
    handleRequest(new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), PORT, deps)
  const bearer = { authorization: `Bearer ${TOKEN}` }
  const cookie = { cookie: sessionCookie(secret).split(';')[0]! }

  expect((await send('PUT', `/dashboard/lease/${LEASE}`, bearer, { mode: 'live' })).status).toBe(200)
  expect((await send('GET', '/dashboard/state', cookie)).status).toBe(204)
  expect((await send('DELETE', `/dashboard/lease/${'N'.repeat(43)}`, bearer)).status).toBe(200)
  expect(activity).toBe(0)
  expect((await send('GET', '/dashboard/', cookie)).status).toBe(200)
  expect(activity).toBe(1)
})
