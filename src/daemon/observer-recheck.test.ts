import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type DashboardRig, startRig } from '../dashboard/test-support'
import { type TempStore, openTempStore } from '../observer/test-support'
import { listSafety, recordSafety } from '../store/observer-safety-store'

const LEAKY_PATH = '/Users/secret/bin/codex'
let temp: TempStore
let rig: DashboardRig

beforeEach(() => {
  temp = openTempStore('sam-recheck-')
  rig = startRig(temp.dataDir)
})
afterEach(async () => {
  await rig.stop()
  temp.cleanup()
})

function seedFailed(provider: 'codex-cli' | 'opencode-cli', version = '1.0'): void {
  recordSafety(temp.store.db, { provider, cliVersion: version, binaryPath: LEAKY_PATH }, 'failed', 'unsafe_cli', 1)
}
const remaining = (): string[] => listSafety(temp.store.db).map((row) => `${row.provider}:${row.status}`)
const choice = (provider: string) => ({ host: 'codex', provider, model: 'm1', credentialRef: null })

test('saving a codex-cli choice clears that provider failed rows only', async () => {
  seedFailed('codex-cli')
  seedFailed('opencode-cli')
  recordSafety(temp.store.db, { provider: 'codex-cli', cliVersion: '2.0', binaryPath: LEAKY_PATH }, 'passed', null, 1)
  expect((await rig.bearer('PUT', '/observer/settings', choice('codex-cli'))).status).toBe(200)
  expect(remaining().sort()).toEqual(['codex-cli:passed', 'opencode-cli:failed'])
})

test('saving the same choice again still clears a newly failed row', async () => {
  expect((await rig.bearer('PUT', '/observer/settings', choice('opencode-cli'))).status).toBe(200)
  seedFailed('opencode-cli')
  expect((await rig.bearer('PUT', '/observer/settings', choice('opencode-cli'))).status).toBe(200)
  expect(remaining()).toEqual([])
})

test('saving another provider clears nothing', async () => {
  seedFailed('codex-cli')
  expect((await rig.bearer('PUT', '/observer/settings', choice('claude-cli'))).status).toBe(200)
  expect((await rig.bearer('PUT', '/observer/settings', { ...choice('openrouter'), credentialRef: 'openrouter' })).status).toBe(200)
  expect(remaining()).toEqual(['codex-cli:failed'])
})

test('GET settings lists the safety rows without a path', async () => {
  seedFailed('codex-cli')
  const text = await (await rig.bearer('GET', '/observer/settings')).text()
  expect(JSON.parse(text).safety).toEqual([{ provider: 'codex-cli', cliVersion: '1.0', status: 'failed', errorClass: 'unsafe_cli', checkedAt: 1 }])
  expect(text).not.toContain(LEAKY_PATH)
})

test('recheck clears the provider failed rows and says how many', async () => {
  seedFailed('codex-cli', '1.0')
  seedFailed('codex-cli', '1.1')
  seedFailed('opencode-cli')
  const response = await rig.bearer('POST', '/observer/recheck', { provider: 'codex-cli' })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, cleared: 2 })
  expect(remaining()).toEqual(['opencode-cli:failed'])
  expect(rig.logs).toContain('observer recheck provider=codex-cli cleared=2')
})

test('recheck takes only the two CLI providers, names the field and never echoes the value', async () => {
  for (const body of [{ provider: 'openrouter' }, { provider: 'bogus-secret-value' }, {}, 'nope']) {
    const response = await rig.bearer('POST', '/observer/recheck', body)
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('provider')
    expect(text).not.toContain('bogus-secret-value')
  }
  expect((await rig.bearer('GET', '/observer/recheck')).status).toBe(405)
})

test('recheck and models take the cookie from our page and the token, like settings', async () => {
  const cookie = await rig.login()
  const recheck = await rig.page('POST', '/observer/recheck', { cookie, body: { provider: 'codex-cli' } })
  expect(recheck.status).toBe(200)
  expect((await rig.page('POST', '/observer/recheck', { cookie, bare: true, body: { provider: 'codex-cli' } })).status).toBe(403)
  expect((await rig.page('GET', '/observer/models?provider=codex-cli', { cookie })).status).not.toBe(401)
})
