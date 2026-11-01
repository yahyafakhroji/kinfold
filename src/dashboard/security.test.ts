import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, openTempStore } from '../observer/test-support'
import { SECURITY_HEADERS } from './headers'
import { listAssets } from './routes'
import { type DashboardRig, startRig } from './test-support'

let temp: TempStore
let rig: DashboardRig

beforeEach(() => {
  temp = openTempStore('sam-dashboard-security-')
  rig = startRig(temp.dataDir)
})
afterEach(async () => {
  await rig.stop()
  temp.cleanup()
})

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const ASSET_PATHS = [...listAssets()].map((name) => `/dashboard/assets/${name}`)

test('login: code with the token, session with the code, then the app page; a code works once', async () => {
  const issued = await rig.bearer('POST', '/dashboard/login-code')
  expect(issued.status).toBe(200)
  const { code, expiresInMs } = (await issued.json()) as { code: string; expiresInMs: number }
  expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(expiresInMs).toBe(60_000)

  const session = await rig.page('POST', '/dashboard/session', { body: { code } })
  expect(session.status).toBe(204)
  const setCookie = session.headers.get('set-cookie') ?? ''
  expect(setCookie).toMatch(/^sam_session=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200$/)
  const cookie = setCookie.split(';')[0]!

  const app = await rig.page('GET', '/dashboard/', { cookie })
  expect(app.status).toBe(200)
  expect(app.headers.get('content-type')).toStartWith('text/html')
  expect(await app.text()).toContain('/dashboard/assets/app.js')

  const again = await rig.page('POST', '/dashboard/session', { body: { code } })
  expect(again.status).toBe(401)
  expect(again.headers.get('set-cookie')).toBeNull()
})

test('a wrong code, a missing code and an extra field are refused', async () => {
  expect((await rig.page('POST', '/dashboard/session', { body: { code: 'A'.repeat(43) } })).status).toBe(401)
  expect((await rig.page('POST', '/dashboard/session', { body: {} })).status).toBe(400)
  const { code } = (await (await rig.bearer('POST', '/dashboard/login-code')).json()) as { code: string }
  expect((await rig.page('POST', '/dashboard/session', { body: { code, admin: true } })).status).toBe(400)
  expect((await rig.page('POST', '/dashboard/session', { body: { code } })).status).toBe(204)
})

test('the login code needs the token; a cookie cannot mint one', async () => {
  const cookie = await rig.login()
  expect((await rig.page('POST', '/dashboard/login-code', { cookie })).status).toBe(401)
  expect((await rig.page('POST', '/dashboard/login-code')).status).toBe(401)
})

test('the cookie is refused on every token-only route', async () => {
  const cookie = await rig.login()
  for (const [method, path] of [['GET', '/sessions'], ['POST', '/context'], ['POST', '/observer/retry'], ['POST', '/spool/nudge'], ['GET', '/nope']] as const) {
    const response = await rig.page(method, path, { cookie, body: method === 'POST' ? {} : undefined })
    expect({ path, status: response.status }).toEqual({ path, status: 401 })
  }
})

test('the routes the dashboard calls take either the cookie or the token', async () => {
  const cookie = await rig.login()
  for (const path of ['/observer/settings', '/data/size', '/data/retention', '/data/findings', '/memory/observations', '/memory/facets', '/metrics/summary']) {
    expect({ path, cookie: (await rig.page('GET', path, { cookie })).status }).toEqual({ path, cookie: 200 })
    expect({ path, token: (await rig.bearer('GET', path)).status }).toEqual({ path, token: 200 })
    expect({ path, none: (await rig.page('GET', path)).status }).toEqual({ path, none: 401 })
  }
})

test('a wrong token next to a good cookie is 401: the Authorization header decides alone', async () => {
  const cookie = await rig.login()
  const response = await rig.page('GET', '/data/size', { cookie, headers: { authorization: `Bearer ${'0'.repeat(64)}` } })
  expect(response.status).toBe(401)
})

const STATE_CHANGING = [
  ['PUT', '/observer/settings', { host: 'opencode', provider: 'claude-cli', model: 'haiku' }],
  ['POST', '/observer/test', { host: 'opencode', provider: 'claude-cli', model: 'haiku' }],
  ['POST', '/data/purge', { host: 'nobody', dryRun: true }],
  ['PUT', '/data/retention', { warnBytes: 1_000_000 }],
  ['POST', '/data/scan', {}],
  ['POST', '/dashboard/logout', undefined],
] as const

test('a state-changing cookie request needs the exact Origin and X-SAM-Request', async () => {
  const cookie = await rig.login()
  const variants: Record<string, Record<string, string>> = {
    'no origin': { 'x-sam-request': '1' },
    'foreign origin': { origin: 'https://evil.example', 'x-sam-request': '1' },
    'localhost origin': { origin: `http://localhost:${rig.daemon.port}`, 'x-sam-request': '1' },
    'null origin': { origin: 'null', 'x-sam-request': '1' },
    'no header': { origin: rig.origin },
    'wrong header': { origin: rig.origin, 'x-sam-request': 'yes' },
  }
  for (const [method, path, body] of STATE_CHANGING) {
    for (const [name, headers] of Object.entries(variants)) {
      const response = await rig.page(method, path, { cookie, body, bare: true, headers })
      expect({ path, name, status: response.status }).toEqual({ path, name, status: 403 })
    }
  }
  const settings = await rig.page('PUT', '/observer/settings', { cookie, body: STATE_CHANGING[0][2] })
  expect(settings.status).toBe(200)
  expect(rig.logs.some((line) => line === 'request refused status=403 reason=origin method=PUT')).toBe(true)
})

test('the token path is unchanged: no Origin needed with the Bearer token', async () => {
  expect((await rig.bearer('POST', '/data/purge', { host: 'nobody', dryRun: true })).status).toBe(200)
})

test('the login exchange itself needs our Origin and header, and the Host check still runs', async () => {
  const { code } = (await (await rig.bearer('POST', '/dashboard/login-code')).json()) as { code: string }
  expect((await rig.page('POST', '/dashboard/session', { body: { code }, bare: true })).status).toBe(403)
  expect((await rig.page('POST', '/dashboard/session', { body: { code }, bare: true, headers: { origin: 'https://evil.example', 'x-sam-request': '1' } })).status).toBe(403)
  const cookie = await rig.login()
  expect((await rig.page('GET', '/dashboard/', { cookie, headers: { host: `evil.example:${rig.daemon.port}` } })).status).toBe(403)
  expect((await rig.page('POST', '/dashboard/session', { body: { code }, headers: { host: `evil.example:${rig.daemon.port}` } })).status).toBe(403)
})

test('signed out, the app page sends you to the login page; sign-out ends the session', async () => {
  const away = await rig.page('GET', '/dashboard/')
  expect(away.status).toBe(303)
  expect(away.headers.get('location')).toBe('/dashboard/login')
  const login = await rig.page('GET', '/dashboard/login')
  expect(login.status).toBe(200)
  expect(await login.text()).toContain('/dashboard/assets/login.js')

  const cookie = await rig.login()
  const out = await rig.page('POST', '/dashboard/logout', { cookie })
  expect(out.status).toBe(204)
  expect(out.headers.get('set-cookie')).toBe('sam_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
  expect((await rig.page('GET', '/data/size', { cookie })).status).toBe(401)
})

test('a daemon restart logs everyone out', async () => {
  const cookie = await rig.login()
  await rig.stop()
  rig = startRig(temp.dataDir)
  expect((await rig.page('GET', '/metrics/summary', { cookie })).status).toBe(401)
})

test('every dashboard response carries the CSP, nosniff, no-referrer, no-store and no CORS header', async () => {
  const cookie = await rig.login()
  const responses = [
    await rig.page('GET', '/dashboard/login'),
    await rig.page('GET', '/dashboard/', { cookie }),
    await rig.page('GET', '/dashboard/'),
    await rig.page('GET', '/dashboard'),
    await rig.page('GET', '/dashboard/assets/missing.js'),
    await rig.page('GET', '/dashboard/assets/../routes.ts'),
    ...(await Promise.all(ASSET_PATHS.map((path) => rig.page('GET', path, { headers: { origin: 'https://evil.example' } })))),
    await rig.page('GET', '/memory/observations', { cookie }),
    await rig.page('GET', '/metrics/summary'),
    await rig.page('POST', '/data/scan', { cookie, bare: true }),
    await rig.bearer('POST', '/dashboard/login-code'),
    await rig.page('OPTIONS', '/memory/observations', { headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' } }),
  ]
  for (const response of responses) {
    expect(response.headers.get('content-security-policy')).toBe(CSP)
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value)
    expect([...response.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([])
  }
})

test('assets are served by allowlist with their types; nothing outside public/ is reachable', async () => {
  expect(ASSET_PATHS).toContain('/dashboard/assets/app.js')
  expect(ASSET_PATHS).toContain('/dashboard/assets/app.css')
  const script = await rig.page('GET', '/dashboard/assets/app.js')
  expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
  const style = await rig.page('GET', '/dashboard/assets/app.css')
  expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
  for (const path of ['/dashboard/assets/routes.ts', '/dashboard/assets/%2e%2e%2froutes.ts', '/dashboard/assets/index.html', '/dashboard/assets/']) {
    expect((await rig.page('GET', path)).status).toBe(404)
  }
  expect((await rig.page('POST', '/dashboard/assets/app.js')).status).toBe(405)
})

test('no served page, asset or answer contains the daemon token, and logs hold no code or cookie', async () => {
  const cookie = await rig.login()
  const { code } = (await (await rig.bearer('POST', '/dashboard/login-code')).json()) as { code: string }
  const bodies = await Promise.all([
    rig.page('GET', '/dashboard/login'), rig.page('GET', '/dashboard/', { cookie }),
    ...ASSET_PATHS.map((path) => rig.page('GET', path)),
    ...['/observer/settings', '/data/size', '/data/retention', '/data/findings', '/memory/observations?q=distinctquerytext', '/memory/facets', '/metrics/summary'].map((path) => rig.page('GET', path, { cookie })),
  ].map(async (pending) => {
    const response = await pending
    return `${[...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join('\n')}\n${await response.text()}`
  }))
  for (const body of bodies) expect(body).not.toContain(rig.token)
  const log = rig.logs.join('\n')
  for (const secret of [rig.token, code, cookie.split('=')[1]!, 'distinctquerytext']) expect(log).not.toContain(secret)
  expect(rig.logs.some((line) => /^dashboard GET \/memory\/observations status=200 ms=\d+$/.test(line))).toBe(true)
})
