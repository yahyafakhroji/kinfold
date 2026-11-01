import { afterEach, beforeEach, expect, test } from 'bun:test'
import { localhostRedirect } from '../daemon/server'
import { type TempStore, openTempStore } from '../observer/test-support'
import { SECURITY_HEADERS } from './headers'
import { type DashboardRig, startRig } from './test-support'

let temp: TempStore
let rig: DashboardRig

beforeEach(() => {
  temp = openTempStore('sam-dashboard-localhost-')
  rig = startRig(temp.dataDir)
})
afterEach(async () => {
  await rig.stop()
  temp.cleanup()
})

const port = (): number => rig.daemon.port
const asLocalhost = (method: string, path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(rig.url(path), { method, redirect: 'manual', ...init, headers: { host: `localhost:${port()}`, ...(init.headers as Record<string, string> | undefined) } })

test('every dashboard path on localhost is a 303 to the same path and query on 127.0.0.1, with no cookie', async () => {
  for (const path of ['/dashboard', '/dashboard/', '/dashboard/login', '/dashboard/assets/app.js', '/dashboard/?page=data']) {
    const answer = await asLocalhost('GET', path)
    expect(answer.status).toBe(303)
    expect(answer.headers.get('location')).toBe(`http://127.0.0.1:${port()}${path}`)
    expect(answer.headers.get('set-cookie')).toBeNull()
    expect(answer.headers.get('content-security-policy')).toBe(SECURITY_HEADERS['content-security-policy']!)
  }
})

test('a login code sent to localhost is not redeemed and sets no cookie; it still works on 127.0.0.1', async () => {
  const { code } = (await (await rig.bearer('POST', '/dashboard/login-code')).json()) as { code: string }
  const onLocalhost = await asLocalhost('POST', '/dashboard/session', {
    headers: { origin: `http://localhost:${port()}`, 'x-sam-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect(onLocalhost.status).toBe(303)
  expect(onLocalhost.headers.get('set-cookie')).toBeNull()
  const onLoopback = await rig.page('POST', '/dashboard/session', { body: { code } })
  expect(onLoopback.status).toBe(204)
  expect(onLoopback.headers.get('set-cookie')).toStartWith('sam_session=')
})

test('following the redirect lands on the 127.0.0.1 login page', async () => {
  const answer = await asLocalhost('GET', '/dashboard/login')
  const followed = await fetch(answer.headers.get('location')!, { redirect: 'manual' })
  expect(followed.status).toBe(200)
  expect(followed.headers.get('content-type')).toStartWith('text/html')
})

test('foreign and look-alike hosts still get 403, on dashboard and API paths alike', async () => {
  const hosts = [`evil.example:${port()}`, `localhost.evil.example:${port()}`, `localhost:${port() + 1}`, 'localhost', `127.0.0.1.nip.io:${port()}`, `LOCALHOST:${port()}`]
  for (const host of hosts) {
    for (const path of ['/dashboard/login', '/data/size']) {
      const answer = await fetch(rig.url(path), { redirect: 'manual', headers: { host, authorization: `Bearer ${rig.token}` } })
      expect(answer.status).toBe(403)
      expect(answer.headers.get('location')).toBeNull()
    }
  }
})

test('API routes on localhost keep their old behaviour: the token works, no redirect', async () => {
  const withToken = await asLocalhost('GET', '/data/size', { headers: { authorization: `Bearer ${rig.token}` } })
  expect(withToken.status).toBe(200)
  expect((await asLocalhost('GET', '/data/size')).status).toBe(401)
})

test('localhostRedirect: only localhost on our port, only /dashboard paths', () => {
  const url = (path: string): URL => new URL(`http://x${path}`)
  expect(localhostRedirect('localhost:7', url('/dashboard/login?a=1'), 7)?.headers.get('location')).toBe('http://127.0.0.1:7/dashboard/login?a=1')
  expect(localhostRedirect('127.0.0.1:7', url('/dashboard/'), 7)).toBeNull()
  expect(localhostRedirect('localhost:7', url('/dashboards'), 7)).toBeNull()
  expect(localhostRedirect('localhost:7', url('/health'), 7)).toBeNull()
  expect(localhostRedirect(null, url('/dashboard/'), 7)).toBeNull()
})
