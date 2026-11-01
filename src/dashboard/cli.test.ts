import { afterEach, beforeEach, expect, test } from 'bun:test'
import { runSam } from '../cli/sam'
import { startDaemon } from '../daemon/daemon'
import { parseDashboardArgs } from '../install/args'
import { EXIT_USAGE } from '../install/install'
import { type FakeWorld, createWorld } from '../install/test-support'

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

test('`sam dashboard --print` prints one login URL with the code in the fragment, and nothing else', async () => {
  const port = startWorldDaemon()
  expect(await runSam(['dashboard', '--print'], world.env)).toBe(0)
  expect(world.out).toHaveLength(1)
  const match = LOGIN_URL.exec(world.out[0]!)
  expect(match).not.toBeNull()
  expect(Number(match![1])).toBe(port)
  expect(world.fetches).toEqual(['POST /dashboard/login-code'])
  expect(world.commands).toEqual([])
})

test('the printed code logs a browser in once', async () => {
  const port = startWorldDaemon()
  await runSam(['dashboard', '--print'], world.env)
  const code = LOGIN_URL.exec(world.out[0]!)![2]!
  const session = (): Promise<Response> => fetch(`http://127.0.0.1:${port}/dashboard/session`, {
    method: 'POST',
    headers: { origin: `http://127.0.0.1:${port}`, 'x-sam-request': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  })
  expect((await session()).status).toBe(204)
  expect((await session()).status).toBe(401)
})

test('without --print it opens the URL with the platform opener, and prints it only if that fails', async () => {
  startWorldDaemon()
  const opened: string[][] = []
  const env = { ...world.env, platform: 'darwin' as const, run: async (request: { argv: readonly string[] }) => (opened.push([...request.argv]), { exitCode: 0, stdout: '' }) }
  expect(await runSam(['dashboard'], env)).toBe(0)
  expect(opened).toHaveLength(1)
  expect(opened[0]![0]).toBe('open')
  expect(opened[0]![1]).toMatch(LOGIN_URL)
  expect(world.out).toEqual(['opened the dashboard in your browser; the link works once, within 60 s'])

  world.out.length = 0
  const failing = { ...env, run: async () => ({ exitCode: 127, stdout: '' }) }
  expect(await runSam(['dashboard'], failing)).toBe(0)
  expect(world.out[0]).toBe('could not open a browser (open exited 127); open this link within 60 s:')
  expect(world.out[1]).toMatch(LOGIN_URL)
})

test('a daemon that is down is exit 1 with one line; bad flags are usage errors', async () => {
  expect(await runSam(['dashboard', '--print'], world.env)).toBe(1)
  expect(world.out).toEqual(['sam dashboard failed: the daemon is not running (no daemon.json or daemon.token)'])
  expect(await runSam(['dashboard', '--open'], world.env)).toBe(EXIT_USAGE)
  expect(parseDashboardArgs(['dashboard'])).toEqual({ ok: true, value: { command: 'dashboard', print: false } })
  expect(parseDashboardArgs(['dashboard', '--print'])).toEqual({ ok: true, value: { command: 'dashboard', print: true } })
  expect(parseDashboardArgs(['dashboard', '--print', '--print'])?.ok).toBe(false)
  expect(parseDashboardArgs(['status'])).toBeNull()
})
