import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { type TempStore, openTempStore } from '../observer/test-support'
import type { CliObserverRunner } from '../observer/runners/cli-core'
import { ObserverError, type ObserverSettings } from '../observer/types'
import { observerModelsRoute } from './observer-models-route'

const LEAK = 'LISTING-OUTPUT-AND-/Users/secret/path'
let temp: TempStore
let rig: DashboardRig
let built: ObserverSettings[]
let listing: () => Promise<string[]>

beforeEach(() => {
  temp = openTempStore('sam-models-')
  built = []
  listing = async () => ['gpt-a', 'gpt-b']
  const cliRunnerFor = (settings: ObserverSettings): CliObserverRunner => {
    built.push(settings)
    return { listModels: () => listing() } as unknown as CliObserverRunner
  }
  rig = startRig(temp.dataDir, { observer: { runnerFor: () => { throw new Error('unused') }, cliRunnerFor, tickMs: 3_600_000, resetCheckMs: 3_600_000 } })
})
afterEach(async () => {
  await rig.stop()
  temp.cleanup()
})

const models = (provider: string) => rig.bearer('GET', `/observer/models?provider=${provider}`)

test('lists models from a runner built with the placeholder model, then serves the cache', async () => {
  expect(await (await models('codex-cli')).json()).toEqual({ ok: true, models: ['gpt-a', 'gpt-b'] })
  listing = async () => ['changed']
  expect(await (await models('codex-cli')).json()).toEqual({ ok: true, models: ['gpt-a', 'gpt-b'] })
  expect(built).toEqual([{ provider: 'codex-cli', model: '-', credentialRef: null, enabled: true, source: 'host' }])
  expect(await (await models('opencode-cli')).json()).toEqual({ ok: true, models: ['changed'] })
})

test('a failure answers its class only, is not cached, and logs provider and class only', async () => {
  listing = async () => { throw new ObserverError('cli_missing', LEAK) }
  const text = await (await models('codex-cli')).text()
  expect(JSON.parse(text)).toEqual({ ok: false, errorClass: 'cli_missing' })
  expect(text).not.toContain(LEAK)
  expect(rig.logs).toContain('observer models provider=codex-cli result=cli_missing')
  expect(rig.logs.join('\n')).not.toContain(LEAK)
  listing = async () => ['now-works']
  expect(await (await models('codex-cli')).json()).toEqual({ ok: true, models: ['now-works'] })
})

test('an unexpected error maps to internal without its text', async () => {
  listing = async () => { throw new TypeError(LEAK) }
  const text = await (await models('codex-cli')).text()
  expect(JSON.parse(text)).toEqual({ ok: false, errorClass: 'internal' })
  expect(text).not.toContain(LEAK)
})

test('only the CLI providers are accepted, without echoing the value; only GET', async () => {
  for (const provider of ['openrouter', 'bogus-secret-value', '']) {
    const response = await models(provider)
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('provider')
    expect(text).not.toContain('bogus-secret-value')
  }
  expect((await rig.bearer('POST', '/observer/models?provider=codex-cli')).status).toBe(405)
  expect(built).toEqual([])
})

test('without a CLI runner factory the route says 503', async () => {
  await rig.stop()
  rig = startRig(temp.dataDir)
  expect((await models('codex-cli')).status).toBe(503)
})

test('the cache expires after ten minutes', async () => {
  let clock = 1_000
  let calls = 0
  const route = observerModelsRoute(
    () => ({ listModels: async () => [`call-${++calls}`] }) as unknown as CliObserverRunner,
    () => {},
    () => clock,
  )
  const url = new URL('http://x/observer/models?provider=codex-cli')
  expect((await route('GET', url)).body).toEqual({ ok: true, models: ['call-1'] })
  clock += 9 * 60_000
  expect((await route('GET', url)).body).toEqual({ ok: true, models: ['call-1'] })
  clock += 2 * 60_000
  expect((await route('GET', url)).body).toEqual({ ok: true, models: ['call-2'] })
})

test('same-provider callers share one listing, a failure included and not cached; other providers run alongside', async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let fail = true
  const route = observerModelsRoute(
    () => ({ listModels: async () => { calls++; await gate; if (fail) throw new ObserverError('timeout', LEAK); return ['m'] } }) as unknown as CliObserverRunner,
    () => {},
    () => 0,
  )
  const codex = new URL('http://x/observer/models?provider=codex-cli')
  const open = new URL('http://x/observer/models?provider=opencode-cli')
  const pending = [route('GET', codex), route('GET', codex), route('GET', open)]
  await Bun.sleep(10)
  expect(calls).toBe(2)
  release()
  const answers = await Promise.all(pending)
  expect(answers.map((a) => a.body)).toEqual(Array(3).fill({ ok: false, errorClass: 'timeout' }))
  fail = false
  expect((await route('GET', codex)).body).toEqual({ ok: true, models: ['m'] })
  expect(calls).toBe(3)
})

test('listed names are capped at 200 entries and overlong names are dropped', async () => {
  const many = [...Array(250).keys()].map((n) => `m${n}`)
  const route = observerModelsRoute(() => ({ listModels: async () => ['x'.repeat(201), ...many] }) as unknown as CliObserverRunner, () => {}, () => 0)
  const body = (await route('GET', new URL('http://x/observer/models?provider=codex-cli'))).body as { models: string[] }
  expect(body.models).toHaveLength(200)
  expect(body.models[0]).toBe('m0')
})
