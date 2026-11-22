import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { runKinfold } from '../../cli/kinfold'
import { startDaemon } from '../../daemon/daemon'
import type { CommandRequest } from '../../../resources/install-plan/env'
import { parseDashboardArgs } from '../../install/args'
import { EXIT_USAGE } from '../../install/install'
import { type FakeWorld, createWorld } from '../install/test-support'
import { OPEN_FILE, SIGN_IN_GRACE_MS, runDashboard } from '../../dashboard/cli'
import { CLOSED_MESSAGE } from '../../dashboard/routes'

let world: FakeWorld
beforeEach(() => {
  world = createWorld()
})
afterEach(async () => world.cleanup())

function startWorldDaemon(): number {
  const daemon = startDaemon({ dataDir: world.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  world.launchd.daemon = daemon
  world.allowedPorts.add(daemon.port)
  return daemon.port
}

const LOGIN_URL = /^http:\/\/127\.0\.0\.1:(\d+)\/dashboard\/login#code=([A-Za-z0-9_-]{43})$/
const ANY_CODE = /[A-Za-z0-9_-]{43}/
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

function signIn(port: number, code: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/dashboard/session`, {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}`, 'x-sam-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
}

const pageGet = (port: number, path: string, cookie: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}${path}`, { headers: { cookie }, redirect: 'manual' })

/** A claim as the login page sends it; without a secret, as any other local program could. */
function claim(port: number, secret?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/dashboard/claim`, {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}`, 'x-sam-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify(secret === undefined ? {} : { claim: secret }),
  })
}

const CLAIM_URL = /http:\/\/127\.0\.0\.1:(\d+)\/dashboard\/login#claim=([A-Za-z0-9_-]{43})/
const openFile = (): string => join(world.dataDir, OPEN_FILE)
/** The claim secret in the page the opener was given, as the browser it opens would read it. */
function secretInOpenFile(port: number): string {
  const match = CLAIM_URL.exec(readFileSync(openFile(), 'utf8'))
  expect(match?.[1]).toBe(String(port))
  return match![2]!
}

const OPENERS: ReadonlyArray<readonly [NodeJS.Platform, (target: string) => string[]]> = [
  ['darwin', (target) => ['open', target]],
  ['linux', (target) => ['xdg-open', target]],
  ['win32', (target) => ['rundll32', 'url.dll,FileProtocolHandler', target]],
]

for (const [platform, argvFor] of OPENERS) {
  test(`${platform}: the opener gets a private file, never the secret; the page claims the sign-in once with it, and Ctrl-C signs out and closes the dashboard`, async () => {
    const port = startWorldDaemon()
    const opened: CommandRequest[] = []
    const stop = new AbortController()
    // A fixed clock: the late fallback, which prints the address, has its own test.
    const env = { ...world.env, platform, now: () => 0, sleep: tick, run: async (request: CommandRequest) => (opened.push(request), { exitCode: 0, stdout: '' }) }
    const running = runDashboard(env, { command: 'dashboard', print: false, close: false }, { stop: stop.signal })

    await until(() => opened.length === 1, 'the browser to open')
    expect(opened[0]!.argv).toEqual(argvFor(openFile()))
    expect(opened[0]!.argv.some((arg) => ANY_CODE.test(arg))).toBe(false)
    if (process.platform !== 'win32') expect(statSync(openFile()).mode & 0o777).toBe(0o600)
    const secret = secretInOpenFile(port)
    // Another local program asking first, with our Origin and header but no secret, gets nothing and spoils nothing.
    const stolen = await claim(port)
    expect(stolen.status).toBe(401)
    expect(stolen.headers.get('set-cookie')).toBeNull()
    const signedIn = await claim(port, secret)
    expect(signedIn.status).toBe(204)
    expect((await claim(port, secret)).status).toBe(401)
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!
    expect((await pageGet(port, '/data/size', cookie)).status).toBe(200)
    await until(() => world.out.some((line) => line.includes('GET /data/size 200')), 'the request line')
    await until(() => world.out.some((line) => line.endsWith('signed in from a browser')), 'the sign-in line')

    stop.abort()
    expect(await running).toBe(0)
    expect(world.out.at(-1)).toBe('Signed out; the dashboard is closed.')
    const after = await pageGet(port, '/data/size', cookie)
    expect(after.status).toBe(401)
    expect(await after.json()).toEqual({ error: CLOSED_MESSAGE, closed: true })
    expect(world.out.some((line) => ANY_CODE.test(line))).toBe(false)
    expect(existsSync(openFile())).toBe(false)
    world.out.length = 0
  })
}

test('a browser that was opened but does not sign in gets the address printed once, after a few seconds', async () => {
  const port = startWorldDaemon()
  const stop = new AbortController()
  let at = 0
  let opened = false
  const env = { ...world.env, now: () => at, sleep: tick, run: async () => ((opened = true), { exitCode: 0, stdout: '' }) }
  const running = runDashboard(env, { command: 'dashboard', print: false, close: false }, { stop: stop.signal })
  await until(() => opened, 'the browser to open')
  for (let i = 0; i < 5; i += 1) await tick()
  expect(world.out.some((line) => CLAIM_URL.test(line))).toBe(false)
  at = SIGN_IN_GRACE_MS
  await until(() => world.out.some((line) => line.startsWith('the browser has not signed in yet')), 'the late fallback line')
  const printed = world.out.filter((line) => CLAIM_URL.test(line))
  expect(printed).toEqual([`http://127.0.0.1:${port}/dashboard/login#claim=${secretInOpenFile(port)}`])
  expect((await claim(port, CLAIM_URL.exec(printed[0]!)![2]!)).status).toBe(204)
  for (let i = 0; i < 5; i += 1) await tick()
  expect(world.out.filter((line) => CLAIM_URL.test(line))).toHaveLength(1)
  stop.abort()
  expect(await running).toBe(0)
})

test('a claim after the command ended is refused, even if its offer was never taken', async () => {
  const port = startWorldDaemon()
  const stop = new AbortController()
  let opened = false
  const env = { ...world.env, sleep: tick, run: async () => ((opened = true), { exitCode: 0, stdout: '' }) }
  const running = runDashboard(env, { command: 'dashboard', print: false, close: false }, { stop: stop.signal })
  await until(() => opened, 'the browser to open')
  const secret = secretInOpenFile(port)
  stop.abort()
  await running
  expect((await claim(port, secret)).status).toBe(401)
  expect(existsSync(openFile())).toBe(false)
})

test('when no browser can be opened the command prints the address with the claim secret in its fragment, to open within 60 s', async () => {
  const port = startWorldDaemon()
  const stop = new AbortController()
  const env = { ...world.env, platform: 'darwin' as const, sleep: tick, run: async () => ({ exitCode: 1, stdout: '' }) }
  const running = runDashboard(env, { command: 'dashboard', print: false, close: false }, { stop: stop.signal })
  await until(() => world.out.some((line) => line.startsWith('could not open a browser')), 'the fallback line')
  const printed = world.out.filter((line) => CLAIM_URL.test(line))
  expect(printed).toHaveLength(1)
  expect(printed[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/dashboard/login#claim=[A-Za-z0-9_-]{43}$`))
  expect(existsSync(openFile())).toBe(false)
  expect((await claim(port)).status).toBe(401)
  expect((await claim(port, CLAIM_URL.exec(printed[0]!)![2]!)).status).toBe(204)
  stop.abort()
  expect(await running).toBe(0)
})

test('a daemon that stops answering is waited for, and the lease is held again when it is back', async () => {
  startWorldDaemon()
  const stop = new AbortController()
  let down = false
  const fetchSome: typeof world.env.fetch = (url, init) => (down && url.includes('/dashboard/lease/') && init.method === 'PUT' ? Promise.reject(new Error('down')) : world.env.fetch(url, init))
  const env = { ...world.env, fetch: fetchSome, sleep: tick, run: async () => ({ exitCode: 0, stdout: '' }) }
  const running = runDashboard(env, { command: 'dashboard', print: false, close: false }, { stop: stop.signal })
  await until(() => world.out.some((line) => line.includes('Ctrl-C')), 'the heading')
  down = true
  await until(() => world.out.some((line) => line.includes('the daemon is not answering')), 'the waiting line')
  down = false
  await until(() => world.out.some((line) => line === 'the daemon is back'), 'the back line')
  stop.abort()
  expect(await running).toBe(0)
})

test('--print prints one link, holds the dashboard open for 12 h, and --close ends it', async () => {
  const port = startWorldDaemon()
  expect(await runKinfold(['dashboard', '--print'], world.env)).toBe(0)
  const match = LOGIN_URL.exec(world.out[0]!)
  expect(match).not.toBeNull()
  expect(Number(match![1])).toBe(port)
  expect(world.out[1]).toBe('the dashboard stays open until `kinfold dashboard --close` or for 12 hours; the link works once, within 60 s')
  expect(world.commands).toEqual([])
  const signedIn = await signIn(port, match![2]!)
  expect(signedIn.status).toBe(204)
  expect((await signIn(port, match![2]!)).status).toBe(401)
  const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!

  world.out.length = 0
  expect(await runKinfold(['dashboard', '--close'], world.env)).toBe(0)
  expect(world.out).toEqual(['closed the dashboard opened with --print'])
  expect((await pageGet(port, '/data/size', cookie)).status).toBe(401)
  world.out.length = 0
  expect(await runKinfold(['dashboard', '--close'], world.env)).toBe(0)
  expect(world.out).toEqual(['no dashboard opened with --print was open'])
})

test('a daemon that is down is exit 1 with one line; bad flags are usage errors', async () => {
  expect(await runKinfold(['dashboard', '--print'], world.env)).toBe(1)
  expect(world.out).toEqual(['kinfold dashboard failed: the daemon is not running (no daemon.json or daemon.token)'])
  expect(await runKinfold(['dashboard', '--open'], world.env)).toBe(EXIT_USAGE)
  expect(parseDashboardArgs(['dashboard'])).toEqual({ ok: true, value: { command: 'dashboard', print: false, close: false } })
  expect(parseDashboardArgs(['dashboard', '--print'])).toEqual({ ok: true, value: { command: 'dashboard', print: true, close: false } })
  expect(parseDashboardArgs(['dashboard', '--close'])).toEqual({ ok: true, value: { command: 'dashboard', print: false, close: true } })
  expect(parseDashboardArgs(['dashboard', '--print', '--print'])?.ok).toBe(false)
  expect(parseDashboardArgs(['dashboard', '--print', '--close'])?.ok).toBe(false)
  expect(parseDashboardArgs(['status'])).toBeNull()
})

test('--print gives its lease back when no code comes, so the dashboard does not stay open for 12 h with nobody signed in', async () => {
  startWorldDaemon()
  const seen: string[] = []
  const failing: typeof world.env.fetch = (url, init) => {
    seen.push(`${init.method} ${new URL(url).pathname.replace(/[A-Za-z0-9_-]{43}$/, '<id>')}`)
    return url.endsWith('/dashboard/login-code') ? Promise.reject(new Error('timeout')) : world.env.fetch(url, init)
  }
  expect(await runDashboard({ ...world.env, fetch: failing }, { command: 'dashboard', print: true, close: false })).toBe(1)
  expect(seen).toEqual(['PUT /dashboard/lease/<id>', 'POST /dashboard/login-code', 'DELETE /dashboard/lease/<id>'])
})

test('a refused renewal ends the command with its reason; only a daemon that does not answer is waited for', async () => {
  startWorldDaemon()
  let renewals = 0
  const refusing: typeof world.env.fetch = async (url, init) => {
    if (url.includes('/dashboard/lease/') && init.method === 'PUT' && (renewals += 1) > 1) return new Response(JSON.stringify({ error: 'too many kinfold dashboard commands are running' }), { status: 409 })
    return world.env.fetch(url, init)
  }
  const env = { ...world.env, fetch: refusing, sleep: tick, run: async () => ({ exitCode: 0, stdout: '' }) }
  expect(await runDashboard(env, { command: 'dashboard', print: false, close: false })).toBe(1)
  expect(world.out.at(-1)).toBe('kinfold dashboard failed: too many kinfold dashboard commands are running')
  expect(world.out.some((line) => line.includes('not answering'))).toBe(false)
})

test('a daemon from before leases answers 401 on the lease route; that reads as an older build', async () => {
  startWorldDaemon()
  const old: typeof world.env.fetch = async (url, init) => (url.includes('/dashboard/lease/') ? new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }) : world.env.fetch(url, init))
  expect(await runDashboard({ ...world.env, fetch: old }, { command: 'dashboard', print: false, close: false })).toBe(1)
  expect(world.out).toEqual(['kinfold dashboard failed: the running daemon is an older build; run kinfold update'])
})
