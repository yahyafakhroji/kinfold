import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../store/db'
import { resolveObserverSettings } from '../observer/settings'
import { type RunningDaemon, startDaemon } from './daemon'
import { parseSettingsPut } from './settings-route'

let root: string
let dataDir: string
let daemon: RunningDaemon
let logs: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-settings-route-'))
  dataDir = join(root, 'data')
  logs = []
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
})
afterEach(async () => {
  await daemon.stop()
  rmSync(root, { recursive: true, force: true })
})

const token = (): string => readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()
const url = (path: string): string => `http://127.0.0.1:${daemon.port}${path}`
const put = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url('/observer/settings'), {
    method: 'PUT',
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const get = (): Promise<Response> => fetch(url('/observer/settings'), { headers: { authorization: `Bearer ${token()}` } })

test('GET reports the built-in defaults for every known host before any row exists', async () => {
  const response = await get()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    rows: [],
    safety: [],
    probe: [],
    effective: [
      { host: 'claude-code', settings: { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true, source: 'built-in' } },
      { host: 'opencode', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'codex', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'cursor', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
    ],
  })
})

test('PUT upserts one row per host, which the observer then resolves', async () => {
  const first = await put({ host: 'opencode', provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter' })
  expect(first.status).toBe(200)
  expect(((await first.json()) as { saved: { host: string } }).saved).toMatchObject({ host: 'opencode', provider: 'openrouter', enabled: true })
  expect((await put({ host: 'opencode', provider: 'claude-cli', model: ' haiku ', credentialRef: 'openrouter' })).status).toBe(200)

  const body = (await (await get()).json()) as { rows: { host: string; model: string; credentialRef: string | null }[] }
  expect(body.rows.map(({ host, model, credentialRef }) => ({ host, model, credentialRef }))).toEqual([
    { host: 'opencode', model: 'haiku', credentialRef: null },
  ])
  await daemon.stop()
  const store = openStore(dataDir)
  expect(resolveObserverSettings(store.db, 'opencode')).toMatchObject({ provider: 'claude-cli', model: 'haiku', source: 'host' })
  store.db.close()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
  expect(logs).toContain('observer settings saved host=opencode provider=claude-cli enabled=true')
})

test('PUT rejects an unknown provider, an empty model and a bad ref with 400, without echoing values', async () => {
  const bad = [
    { host: 'opencode', provider: 'gpt-secret-provider', model: 'x' },
    { host: 'opencode', provider: 'openrouter', model: '   ' },
    { host: 'opencode', provider: 'openrouter', model: 'm', credentialRef: '-w; rm -rf /' },
    { host: 'Bad Host', provider: 'openrouter', model: 'm' },
    { host: 'opencode', provider: 'openrouter', model: 'm', enabled: 'yes' },
  ]
  for (const body of bad) {
    const response = await put(body)
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).not.toContain('gpt-secret-provider')
    expect(text).not.toContain('rm -rf')
  }
  expect(((await (await get()).json()) as { rows: unknown[] }).rows).toEqual([])
})

test('the settings routes need the token and a loopback Host, like every other route', async () => {
  expect((await fetch(url('/observer/settings'))).status).toBe(401)
  expect((await put({ host: 'opencode', provider: 'openrouter', model: 'm' }, { authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401)
  expect((await put({ host: 'opencode', provider: 'openrouter', model: 'm' }, { host: `evil.example:${daemon.port}` })).status).toBe(403)
  expect((await fetch(url('/observer/settings'), { method: 'POST', headers: { authorization: `Bearer ${token()}` } })).status).toBe(405)
})

test('parseSettingsPut accepts the default row and drops a ref for claude-cli', () => {
  expect(parseSettingsPut({ host: '*', provider: 'claude-cli', model: 'haiku', credentialRef: 'openrouter', enabled: false })).toEqual({
    ok: true,
    value: { host: '*', provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: false },
  })
  expect(parseSettingsPut([])).toEqual({ ok: false, error: 'body must be a JSON object' })
})

test('a setting may not name a key Kinfold keeps for itself, so the observer never sends one to a provider', () => {
  for (const credentialRef of ['db-key', 'hmac-master', 'hmac-legacy']) {
    expect(parseSettingsPut({ host: '*', provider: 'openrouter', model: 'openrouter/auto', credentialRef, enabled: true }))
      .toEqual({ ok: false, error: 'credentialRef names a key Kinfold keeps for itself' })
  }
})

test('parseSettingsPut drops the credentialRef for codex-cli and still rejects an unknown provider by name', () => {
  const ok = parseSettingsPut({ host: 'codex', provider: 'codex-cli', model: 'gpt-x', credentialRef: 'openrouter' })
  expect(ok).toMatchObject({ ok: true, value: { provider: 'codex-cli', credentialRef: null } })
  const bad = parseSettingsPut({ host: 'codex', provider: 'bogus', model: 'm' })
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.error).toContain('provider')
})
