import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { START_WAIT_MS, getQuietForMs, projectMergeLines, waitForStart } from './daemon-client'
import type { InstallEnv } from './env'
import { installPaths } from './env'
import { applyAction } from './plan'
import { type FakeWorld, createWorld, fakeService } from './test-support'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const HEALTH_BODY = JSON.stringify({ ok: true, version: '1.0.0', schemaVersion: 1 })

/** The world's env with a clock that only moves when the code sleeps, and a /health that answers from `upAtMs` on. */
function clockEnv(upAtMs: number | null, extra: Partial<InstallEnv> = {}): { env: InstallEnv; elapsed: () => number } {
  world = createWorld()
  let clock = 0
  const env: InstallEnv = {
    ...world.env,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    fetch: (async () => (upAtMs !== null && clock >= upAtMs ? new Response(HEALTH_BODY) : Promise.reject(new Error('refused')))) as unknown as InstallEnv['fetch'],
    out: (line) => void world?.out.push(line),
    ...extra,
  }
  return { env, elapsed: () => clock }
}

test('a daemon that answers after 40 s passes', async () => {
  const { env } = clockEnv(40_000)
  const result = await waitForStart(env, null)
  expect(result.ok).toBe(true)
  const progress = world?.out.filter((line) => line.startsWith('still waiting for the daemon')) ?? []
  expect(progress).toEqual([
    'still waiting for the daemon (15 s): it opens memory.db and reads the spool before it answers',
    'still waiting for the daemon (30 s): it opens memory.db and reads the spool before it answers',
  ])
})

test('a service that stops running ends the wait early', async () => {
  const { env, elapsed } = clockEnv(null)
  const service = fakeService()
  const running = service.isRunning
  service.isRunning = async () => (elapsed() < 20_000 ? running() : false)
  const result = await waitForStart(env, service)
  expect(result).toEqual({ ok: false, reason: 'not-running' })
  expect(elapsed()).toBeLessThan(30_000)
})

test('a service that stays loaded is waited on until the timeout', async () => {
  const { env, elapsed } = clockEnv(null)
  const result = await waitForStart(env, fakeService())
  expect(result).toEqual({ ok: false, reason: 'timeout' })
  expect(elapsed()).toBeGreaterThanOrEqual(START_WAIT_MS)
})

test('a timeout says the daemon may still be starting', async () => {
  const { env } = clockEnv(null, { service: null })
  await expect(applyAction(env, { kind: 'wait-health' })).rejects.toThrow(
    `the daemon did not answer /health within 180 s; it may still be opening a large store. Run kinfold status in a minute; the log is ${installPaths(env).logFile}`,
  )
})

test('the plan step names the service when it stops running', async () => {
  const { env, elapsed } = clockEnv(null)
  const service = fakeService()
  service.isRunning = async () => elapsed() < 10_000
  await expect(applyAction({ ...env, service }, { kind: 'wait-health' })).rejects.toThrow(
    `the FakeService stopped running before the daemon answered /health; the log is ${installPaths(env).logFile}`,
  )
})

test('an isRunning that throws counts as running', async () => {
  const { env, elapsed } = clockEnv(40_000)
  const service = fakeService()
  service.isRunning = async () => {
    throw new Error('launchctl failed')
  }
  const result = await waitForStart(env, service)
  expect(result.ok).toBe(true)
  expect(elapsed()).toBeGreaterThanOrEqual(40_000)
})

test('isRunning is asked every 5 s, not every poll', async () => {
  const { env } = clockEnv(20_000)
  const service = fakeService()
  await waitForStart(env, service)
  expect(service.calls.filter((call) => call === 'isRunning')).toHaveLength(3)
})

// ---- the quiet question the updater asks ----

function quietWorld(answer: (url: string, init: RequestInit) => Response | Promise<Response>, files: boolean = true): FakeWorld {
  const w = createWorld()
  world = w
  mkdirSync(w.dataDir, { recursive: true })
  if (files) {
    writeFileSync(join(w.dataDir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 40_123 }))
    writeFileSync(join(w.dataDir, 'daemon.token'), 'a'.repeat(64))
  }
  w.env = { ...w.env, fetch: async (url, init) => answer(url, init) }
  return w
}

test('the quiet question goes to the daemon with its token, and the answer is how long it has been quiet', async () => {
  const asked: { url: string; authorization: string | null }[] = []
  const w = quietWorld((url, init) => {
    asked.push({ url, authorization: new Headers(init.headers).get('authorization') })
    return new Response(JSON.stringify({ quietForMs: 123_000 }))
  })
  expect(await getQuietForMs(w.env)).toBe(123_000)
  expect(asked).toEqual([{ url: 'http://127.0.0.1:40123/update/quiet', authorization: `Bearer ${'a'.repeat(64)}` }])
})

test('no daemon, an older daemon, or an answer that is not a time all read as no answer', async () => {
  expect(await getQuietForMs(quietWorld(() => new Response('{}'), false).env)).toBeNull()
  await world?.cleanup()
  for (const answer of [() => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }), () => new Response(JSON.stringify({ quietForMs: 'soon' })), () => new Response(JSON.stringify({ quietForMs: -5 })), () => new Response('nope'), () => { throw new TypeError('refused') }]) {
    expect(await getQuietForMs(quietWorld(answer).env)).toBeNull()
    await world?.cleanup()
  }
})

test('project merge lines name each recent merge once, and say nothing when there is none or the daemon cannot say', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kinfold-merge-lines-'))
  writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ pid: process.pid, port: 40_123 }))
  writeFileSync(join(dir, 'daemon.token'), 'a'.repeat(64))
  const lines = (body: unknown, status = 200) => projectMergeLines({ dataDir: dir, fetch: async () => Response.json(body, { status }) } as never)
  expect(await lines({ projects: [], merges: [{ from: 'shared-agent-memory', into: 'kinfold', fromKey: 'a', intoKey: 'b', reason: 'same-repo', at: 1 }, { from: 'rea', into: 'kinfold', fromKey: 'c', intoKey: 'b', reason: 'manual', at: 2 }] }))
    .toEqual(['project: merged shared-agent-memory into kinfold (same repo)', 'project: merged rea into kinfold (kinfold project merge)'])
  expect(await lines({ projects: [], merges: [] })).toEqual([])
  expect(await lines({ error: 'x' }, 404)).toEqual([])
  rmSync(dir, { recursive: true, force: true })
})
