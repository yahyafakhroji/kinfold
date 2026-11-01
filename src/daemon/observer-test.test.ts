import { afterEach, beforeEach, expect, test } from 'bun:test'
import { CHECK_PROMPT } from '../install/observer-choice'
import { type FakeRunner, type TempStore, fakeRunner, openTempStore } from '../observer/test-support'
import { ObserverError, type ObserverSettings } from '../observer/types'
import { type DashboardRig, startRig } from '../dashboard/test-support'

const LEAKY_DETAIL = 'sk-or-v1-REPLY-TEXT-THAT-MUST-NOT-LEAK'

let temp: TempStore
let rig: DashboardRig
let built: ObserverSettings[]
let runner: FakeRunner
let factory: (settings: ObserverSettings) => FakeRunner

beforeEach(() => {
  temp = openTempStore('sam-observer-test-')
  built = []
  runner = fakeRunner([`OK ${LEAKY_DETAIL}`])
  factory = (settings) => {
    built.push(settings)
    return runner
  }
  rig = startRig(temp.dataDir, { observer: { runnerFor: (settings) => factory(settings), tickMs: 3_600_000, resetCheckMs: 3_600_000 } })
})
afterEach(async () => {
  await rig.stop()
  temp.cleanup()
})

const BODY = { host: 'opencode', provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter' }

test('a working model answers ok; the runner got the fixed check prompt and the unsaved choice', async () => {
  const response = await rig.bearer('POST', '/observer/test', BODY)
  expect(response.status).toBe(200)
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({ ok: true })
  expect(text).not.toContain(LEAKY_DETAIL)
  expect(runner.prompts).toEqual([CHECK_PROMPT])
  expect(built).toEqual([{ provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'host' }])
  expect(temp.store.db.query('SELECT count(*) AS n FROM observer_settings').get()).toEqual({ n: 0 })
  expect(temp.store.db.query('SELECT count(*) AS n FROM observer_runs').get()).toEqual({ n: 0 })
})

test('a failing model answers its error class only, never the detail', async () => {
  runner = fakeRunner([new ObserverError('http_error', `status 402 ${LEAKY_DETAIL}`)])
  const response = await rig.bearer('POST', '/observer/test', BODY)
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({ ok: false, errorClass: 'http_error' })
  expect(text).not.toContain(LEAKY_DETAIL)
  expect(rig.logs.join('\n')).not.toContain(LEAKY_DETAIL)
  expect(rig.logs.some((line) => /^observer test provider=openrouter result=http_error ms=\d+$/.test(line))).toBe(true)
})

test('a runner that cannot be built (no credential) and an unknown error map to classes', async () => {
  factory = () => {
    throw new ObserverError('credential_missing', `no keychain entry for ${LEAKY_DETAIL}`)
  }
  expect(await (await rig.bearer('POST', '/observer/test', BODY)).json()).toEqual({ ok: false, errorClass: 'credential_missing' })
  runner = fakeRunner([new TypeError(LEAKY_DETAIL)])
  factory = () => runner
  const text = await (await rig.bearer('POST', '/observer/test', BODY)).text()
  expect(JSON.parse(text)).toEqual({ ok: false, errorClass: 'internal' })
  expect(text).not.toContain(LEAKY_DETAIL)
})

test('the body is checked like PUT /observer/settings, and only POST is allowed', async () => {
  for (const body of [{}, { ...BODY, provider: 'gpt' }, { ...BODY, model: '' }, { ...BODY, host: 'Bad Host' }, 'not json']) {
    expect((await rig.bearer('POST', '/observer/test', body)).status).toBe(400)
  }
  expect((await rig.bearer('GET', '/observer/test')).status).toBe(405)
  expect(built).toEqual([])
})

test('one test at a time: a second request while one runs is 409', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  factory = () => ({ prompts: [], run: async () => { await gate; return { text: 'OK', model: 'm' } } })
  const first = rig.bearer('POST', '/observer/test', BODY)
  await Bun.sleep(20)
  expect((await rig.bearer('POST', '/observer/test', BODY)).status).toBe(409)
  release()
  expect(await (await first).json()).toEqual({ ok: true })
})

test('without an observer the route says so with 503', async () => {
  await rig.stop()
  rig = startRig(temp.dataDir)
  expect((await rig.bearer('POST', '/observer/test', BODY)).status).toBe(503)
})
