import { afterEach, expect, test } from 'bun:test'
import { START_WAIT_MS, waitForStart } from './daemon-client'
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
