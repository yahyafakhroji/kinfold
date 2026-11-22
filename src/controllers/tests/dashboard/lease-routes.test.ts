import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LIVE_LEASE_TTL_MS } from './auth'
import { CLOSED_MESSAGE } from './routes'
import { type DashboardRig, cookiePair, startRig } from './test-support'

const LEASE = 'L'.repeat(43)
let dir = ''
let rig: DashboardRig
let at = 1_000_000

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-lease-'))
  at = 1_000_000
  rig = startRig(dir, { dashboard: { now: () => at } })
})
afterEach(async () => {
  await rig.stop()
  if (dir.startsWith(tmpdir())) rmSync(dir, { recursive: true, force: true })
})

async function signIn(lease: string = LEASE): Promise<string> {
  expect((await rig.bearer('PUT', `/dashboard/lease/${lease}`, { mode: 'live' })).status).toBe(200)
  const issued = await rig.bearer('POST', '/dashboard/login-code', { lease })
  const { code } = (await issued.json()) as { code: string }
  const session = await rig.page('POST', '/dashboard/session', { body: { code } })
  return cookiePair(session.headers.get('set-cookie'))
}

test('with no kinfold dashboard running, pages and API calls are refused as closed; the login page still answers', async () => {
  const page = await rig.page('GET', '/dashboard/')
  expect(page.status).toBe(303)
  expect(page.headers.get('location')).toBe('/dashboard/login#closed')
  expect((await rig.page('GET', '/dashboard/login')).status).toBe(200)
  const code = await rig.bearer('POST', '/dashboard/login-code', { lease: LEASE })
  expect(code.status).toBe(409)
  expect(((await code.json()) as { error: string }).error).toBe(CLOSED_MESSAGE)
  const api = await rig.page('GET', '/metrics/summary')
  expect(api.status).toBe(401)
  expect(await api.json()).toEqual({ error: CLOSED_MESSAGE, closed: true })
  // Token callers are not the dashboard: the CLI keeps working.
  expect((await rig.bearer('GET', '/observer/settings')).status).toBe(200)
})

test('a killed command stops renewing, and its lease lapses within 15 s: the session is refused as closed', async () => {
  const cookie = await signIn()
  expect((await rig.page('GET', '/dashboard/state', { cookie })).status).toBe(204)
  at += LIVE_LEASE_TTL_MS - 1
  expect((await rig.page('GET', '/dashboard/state', { cookie })).status).toBe(204)
  at += 1
  const state = await rig.page('GET', '/dashboard/state', { cookie })
  expect(state.status).toBe(401)
  expect(await state.json()).toEqual({ error: CLOSED_MESSAGE, closed: true })
  expect((await rig.page('GET', '/dashboard/', { cookie })).headers.get('location')).toBe('/dashboard/login#closed')
})

test('releasing the lease (Ctrl-C) ends its sessions at once', async () => {
  const cookie = await signIn()
  const released = await rig.bearer('DELETE', `/dashboard/lease/${LEASE}`)
  expect(released.status).toBe(200)
  expect(await released.json()).toEqual({ sessionsEnded: 1 })
  expect((await rig.page('GET', '/dashboard/state', { cookie })).status).toBe(401)
  // Holding the same id again does not sign the old session back in.
  await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'live' })
  expect((await rig.page('GET', '/dashboard/state', { cookie })).status).toBe(401)
})

test('two commands: each keeps its own sessions, and the dashboard stays open while either holds a lease', async () => {
  const other = 'M'.repeat(43)
  const mine = await signIn()
  const theirs = await signIn(other)
  await rig.bearer('DELETE', `/dashboard/lease/${LEASE}`)
  expect((await rig.page('GET', '/dashboard/state', { cookie: mine })).status).toBe(401)
  expect((await rig.page('GET', '/dashboard/state', { cookie: theirs })).status).toBe(204)
})

test('--close ends --print leases only', async () => {
  await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'print' })
  const printed = (await (await rig.bearer('POST', '/dashboard/login-code', { lease: LEASE })).json()) as { code: string }
  const cookie = cookiePair((await rig.page('POST', '/dashboard/session', { body: { code: printed.code } })).headers.get('set-cookie'))
  const live = await signIn('M'.repeat(43))
  const closed = await rig.bearer('POST', '/dashboard/close')
  expect(await closed.json()).toEqual({ closed: 1 })
  expect((await rig.page('GET', '/dashboard/state', { cookie })).status).toBe(401)
  expect((await rig.page('GET', '/dashboard/state', { cookie: live })).status).toBe(204)
})

test('the heartbeat answers the log after its cursor: requests by path and status, and sign-ins, never a query string or body', async () => {
  const first = (await (await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'live' })).json()) as { ttlMs: number; epoch: string; cursor: number; events: unknown[] }
  expect(first.ttlMs).toBe(LIVE_LEASE_TTL_MS)
  expect(first.events).toEqual([])
  const issued = (await (await rig.bearer('POST', '/dashboard/login-code', { lease: LEASE })).json()) as { code: string }
  const cookie = cookiePair((await rig.page('POST', '/dashboard/session', { body: { code: issued.code } })).headers.get('set-cookie'))
  await rig.page('GET', '/metrics/summary?window=secret-term', { cookie })
  const next = await rig.bearer('PUT', `/dashboard/lease/${LEASE}?after=${first.cursor}&epoch=${first.epoch}`, { mode: 'live' })
  const body = (await next.json()) as { cursor: number; events: Array<Record<string, unknown>> }
  const text = JSON.stringify(body.events)
  expect(text).not.toContain('secret-term')
  expect(text).not.toContain(issued.code)
  expect(body.events.find((event) => event.kind === 'event' && event.text === 'signed in from a browser')).toBeDefined()
  expect(body.events.find((event) => event.kind === 'request' && event.path === '/metrics/summary' && event.status === 400 && event.method === 'GET')).toBeDefined()
  const again = (await (await rig.bearer('PUT', `/dashboard/lease/${LEASE}?after=${body.cursor}&epoch=${first.epoch}`, { mode: 'live' })).json()) as { events: unknown[] }
  expect(again.events).toEqual([])
})

test('lease routes take the token only, and refuse a malformed id or mode', async () => {
  const cookie = await signIn()
  expect((await rig.page('PUT', `/dashboard/lease/${LEASE}`, { cookie, body: { mode: 'live' } })).status).toBe(401)
  expect((await rig.page('POST', '/dashboard/close', { cookie })).status).toBe(401)
  expect((await rig.bearer('PUT', '/dashboard/lease/short', { mode: 'live' })).status).toBe(400)
  expect((await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'forever' })).status).toBe(400)
  expect((await rig.bearer('GET', `/dashboard/lease/${LEASE}`)).status).toBe(405)
})

const CLAIM = 'c'.repeat(43)
const digestOf = (secret: string): string => createHash('sha256').update(secret).digest('hex')
const offer = (lease: string = LEASE, secret: string = CLAIM): Promise<Response> => rig.bearer('POST', '/dashboard/offer', { lease, claim: digestOf(secret) })

async function claim(options: { bare?: boolean; secret?: string | null } = {}): Promise<Response> {
  const secret = options.secret === undefined ? CLAIM : options.secret
  return rig.page('POST', '/dashboard/claim', { ...(options.bare === true ? { bare: true } : {}), ...(secret === null ? {} : { body: { claim: secret } }) })
}

test('the command offers a sign-in with the token and its secret\'s digest; the page claims it once with the secret', async () => {
  await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'live' })
  const offered = await offer()
  expect(offered.status).toBe(200)
  expect(await offered.json()).toEqual({ expiresInMs: 60_000 })
  const claimed = await claim()
  expect(claimed.status).toBe(204)
  const cookie = cookiePair(claimed.headers.get('set-cookie'))
  expect((await rig.page('GET', '/dashboard/state', { cookie })).status).toBe(204)
  const again = await claim()
  expect(again.status).toBe(401)
  expect(again.headers.get('set-cookie')).toBeNull()
})

test('a local program that sends our Origin and header but not the secret gets no session, and the real page still signs in', async () => {
  await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'live' })
  await offer()
  // What `curl -H 'Origin: ...' -H 'x-sam-request: 1'` could send while the offer waits.
  for (const secret of [null, 'd'.repeat(43), digestOf(CLAIM), '', 'short']) {
    const taken = await claim({ secret })
    expect(taken.status).toBe(401)
    expect(taken.headers.get('set-cookie')).toBeNull()
  }
  expect((await rig.page('POST', '/dashboard/claim', { body: { claim: CLAIM, extra: 1 } })).status).toBe(401)
  expect(rig.logs.join('\n')).not.toContain(CLAIM)
  expect((await claim()).status).toBe(204)
})

test('a claim needs our Origin and header; an offer needs the token, a live lease and a digest', async () => {
  await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'live' })
  await offer()
  expect((await claim({ bare: true })).status).toBe(403)
  expect((await rig.page('POST', '/dashboard/claim', { headers: { origin: 'https://evil.example' }, body: { claim: CLAIM } })).status).toBe(403)
  expect((await rig.page('GET', '/dashboard/claim')).status).toBe(405)
  expect((await claim()).status).toBe(204)
  expect((await rig.page('POST', '/dashboard/offer', { body: { lease: LEASE, claim: digestOf(CLAIM) } })).status).toBe(401)
  // The body an older command sends, the secret itself, and a short digest: none is an offer.
  for (const body of [{ lease: LEASE }, { lease: LEASE, claim: CLAIM }, { lease: LEASE, claim: digestOf(CLAIM).slice(2) }]) expect((await rig.bearer('POST', '/dashboard/offer', body)).status).toBe(400)
  const closed = await offer('M'.repeat(43))
  expect(closed.status).toBe(409)
  expect(((await closed.json()) as { error: string }).error).toBe(CLOSED_MESSAGE)
})

test('a claim after the command ended (Ctrl-C) is refused', async () => {
  await rig.bearer('PUT', `/dashboard/lease/${LEASE}`, { mode: 'live' })
  await offer()
  await rig.bearer('DELETE', `/dashboard/lease/${LEASE}`)
  expect((await claim()).status).toBe(401)
})

test('a page whose own command ended is told the dashboard closed, while another command keeps it open', async () => {
  const mine = await signIn()
  const theirs = await signIn('M'.repeat(43))
  await rig.bearer('DELETE', `/dashboard/lease/${LEASE}`)
  const state = await rig.page('GET', '/dashboard/state', { cookie: mine })
  expect(state.status).toBe(401)
  expect(await state.json()).toEqual({ error: CLOSED_MESSAGE, closed: true })
  expect((await rig.page('GET', '/dashboard/', { cookie: mine })).headers.get('location')).toBe('/dashboard/login#closed')
  expect((await rig.page('GET', '/dashboard/state', { cookie: theirs })).status).toBe(204)
  // A browser that never signed in is not told it closed: the dashboard is open, it only needs a sign-in.
  const stranger = await rig.page('GET', '/dashboard/state')
  expect(await stranger.json()).toEqual({ error: 'unauthorized' })
})
