import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../store/db'
import { CLAUDE_TOKEN_REF, resolveObserverSettings } from '../observer/settings'
import { recordingKeyStore } from '../install/test-support'
import { type RunningDaemon, startDaemon } from './daemon'
import { observerSettingsView, parseSettingsPut } from './settings-route'
import { T0, openTempStore, seedSession } from '../observer/test-support'
import { finishRun, startRun } from '../store/observer-store'

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
    backoff: [],
    claudeAuth: 'login',
    effective: [
      { host: 'claude-code', settings: { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true, source: 'built-in' } },
      { host: 'opencode', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'codex', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'cursor', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'gemini-cli', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'qwen-code', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'factory-droid', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'devin', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'kilo-code', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'cline', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'copilot', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'antigravity', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'junie', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'kiro', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'amp', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'kimi-code', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'auggie', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'goose', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'crush', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'zed', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'continue', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
      { host: 'warp', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
    ],
  })
})

test('the view lists each provider that is backing off, with the line status and the dashboard show', () => {
  const temp = openTempStore('kinfold-view-backoff-')
  try {
    const session = seedSession(temp.store, 'claude-code', 's1')
    for (const at of [T0, T0 + 10_000]) {
      const id = startRun(temp.store.db, { sessionId: session, host: 'claude-code', provider: 'claude-cli', model: 'haiku', eventCount: 1, startedAt: at })
      finishRun(temp.store.db, id, 'failed', 'exit_nonzero: claude exited 1', at + 1_000)
    }
    const view = observerSettingsView(temp.store.db, [], T0 + 20_000)
    expect(view.backoff).toEqual([{
      provider: 'claude-cli', errorClass: 'exit_nonzero', failures: 2, since: T0, retryAt: T0 + 11_000 + 120_000,
      line: expect.stringMatching(/^claude-cli has failed 2 times since .+: exit_nonzero; retrying at .+; check `claude` works in a terminal$/),
    }])
  } finally {
    temp.cleanup()
  }
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

test('parseSettingsPut keeps a checked endpoint for an endpoint provider and drops one for any other', () => {
  expect(parseSettingsPut({ host: 'codex', provider: 'openai-compatible', model: 'llama3.2', endpoint: 'http://127.0.0.1:11434/v1/', enabled: true })).toEqual({
    ok: true,
    value: { host: 'codex', provider: 'openai-compatible', model: 'llama3.2', credentialRef: null, enabled: true, endpoint: 'http://127.0.0.1:11434/v1' },
  })
  expect(parseSettingsPut({ host: 'codex', provider: 'anthropic-api', model: 'claude-haiku-5-5', credentialRef: 'anthropic', endpoint: 'https://x.example.com' })).toEqual({
    ok: true,
    value: { host: 'codex', provider: 'anthropic-api', model: 'claude-haiku-5-5', credentialRef: 'anthropic', enabled: true },
  })
})

test('parseSettingsPut refuses what resolve or the runner would refuse, without echoing the value', () => {
  expect(parseSettingsPut({ host: 'codex', provider: 'openai-compatible', model: 'm' })).toEqual({ ok: false, error: 'endpoint is needed for openai-compatible' })
  expect(parseSettingsPut({ host: 'codex', provider: 'openai-compatible', model: 'm', endpoint: 7 })).toEqual({ ok: false, error: 'endpoint must be a string' })
  expect(parseSettingsPut({ host: 'codex', provider: 'openai-compatible', model: 'm', endpoint: 'http://10.1.2.3/v1' })).toEqual({ ok: false, error: 'the endpoint must use https unless it is on this machine (127.0.0.1, ::1 or localhost)' })
  expect(parseSettingsPut({ host: 'codex', provider: 'qwen-api', model: 'm', endpoint: 'https://api.example.com/v1' })).toEqual({ ok: false, error: 'the Qwen endpoint must be an https DashScope or Model Studio URL' })
  expect(parseSettingsPut({ host: 'codex', provider: 'goose-cli', model: 'claude-code/sonnet' })).toEqual({ ok: false, error: 'goose-cli models are <provider>/<model>, provider one of anthropic, openai, google, openrouter, xai, ollama, tetrate' })
})

test('parseSettingsPut never pairs a provider with another provider\'s key', () => {
  const put = (provider: string, credentialRef: string | null, endpoint?: string) => parseSettingsPut({ host: '*', provider, model: 'm', credentialRef, ...(endpoint === undefined ? {} : { endpoint }) })
  const refused = { ok: false, error: 'credentialRef names the key of another provider' } as const
  expect(put('openai-compatible', 'anthropic', 'https://evil.example/v1')).toEqual(refused)
  expect(put('openai-compatible', 'openrouter', 'https://evil.example/v1')).toEqual(refused)
  expect(put('qwen-api', 'openai', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toEqual(refused)
  expect(put('anthropic-api', 'gemini')).toEqual(refused)
  expect(put('anthropic-api', 'anthropic')).toMatchObject({ ok: true })
  expect(put('openai-compatible', 'openai-compatible', 'https://api.groq.com/openai/v1')).toMatchObject({ ok: true })
  expect(put('openai-compatible', 'groq', 'https://api.groq.com/openai/v1')).toMatchObject({ ok: true })
  expect(put('openrouter', 'openai-compatible')).toEqual(refused)
})

test('no API provider may read the Claude login token as its key, least of all one that names its own address', () => {
  const put = (provider: string, endpoint?: string) => parseSettingsPut({ host: '*', provider, model: 'm', credentialRef: 'claude-oauth-token', ...(endpoint === undefined ? {} : { endpoint }) })
  const refused = { ok: false, error: 'credentialRef names the key of another provider' } as const
  expect(put('openai-compatible', 'https://evil.example/v1')).toEqual(refused)
  expect(put('qwen-api', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toEqual(refused)
  for (const provider of ['openrouter', 'anthropic-api', 'openai-api', 'gemini-api']) expect(put(provider)).toEqual(refused)
})

test('the view says which login claude-cli runs on, and a login problem on a token says to make a new token', () => {
  const temp = openTempStore('kinfold-view-token-')
  try {
    const session = seedSession(temp.store, 'claude-code', 's1')
    const id = startRun(temp.store.db, { sessionId: session, host: 'claude-code', provider: 'claude-cli', model: 'haiku', eventCount: 1, startedAt: T0 })
    finishRun(temp.store.db, id, 'failed', 'auth_expired: claude exited 1 (long-lived token): OAuth token has expired', T0 + 1_000)
    expect(observerSettingsView(temp.store.db, [], T0 + 2_000).claudeAuth).toBe('login')
    const view = observerSettingsView(temp.store.db, [], T0 + 2_000, 'token')
    expect(view.claudeAuth).toBe('token')
    expect(view.backoff[0]!.line).toContain('run `claude setup-token` again')
  } finally {
    temp.cleanup()
  }
})

const TOKEN = 'sk-ant-oat01-FAKE-ROUTE-TOKEN-000000000'
const tokenRoute = (port: number, method: string, body?: unknown): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/observer/claude-token`, {
    method, headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

test('the dashboard stores and removes the claude-cli token in the key store; the token is never logged or sent back', async () => {
  const keyStore = recordingKeyStore()
  const lines: string[] = []
  const other = startDaemon({ dataDir: join(root, 'with-store'), port: 0, fallbackDrainMs: 60_000, log: (line) => lines.push(line), keyStore })
  const auth = { authorization: `Bearer ${readFileSync(join(root, 'with-store', 'daemon.token'), 'utf8').trim()}`, 'content-type': 'application/json' }
  const call = (method: string, body?: unknown) => fetch(`http://127.0.0.1:${other.port}/observer/claude-token`, { method, headers: auth, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    expect(await (await call('GET')).json()).toEqual({ auth: 'login' })
    const saved = await call('PUT', { token: `  ${TOKEN}\n` })
    expect(saved.status).toBe(200)
    const answer = await saved.text()
    expect(answer).not.toContain(TOKEN)
    expect(JSON.parse(answer)).toEqual({ auth: 'token' })
    expect(keyStore.values.get(CLAUDE_TOKEN_REF)).toBe(TOKEN)
    const view = await (await fetch(`http://127.0.0.1:${other.port}/observer/settings`, { headers: auth })).json() as { claudeAuth: string }
    expect(view.claudeAuth).toBe('token')
    const bad = await call('PUT', { token: 'has a space' })
    expect(bad.status).toBe(400)
    expect(await bad.text()).not.toContain('has a space')
    expect(await (await call('DELETE')).json()).toEqual({ auth: 'login' })
    expect(keyStore.values.has(CLAUDE_TOKEN_REF)).toBe(false)
    expect(lines.join('\n')).not.toContain(TOKEN)
    expect(lines).toContain('observer claude-cli token saved')
  } finally {
    await other.stop()
  }
})

test('without a key store the token route says so instead of keeping the token anywhere else', async () => {
  const response = await tokenRoute(daemon.port, 'PUT', { token: TOKEN })
  expect(response.status).toBe(503)
  expect(await response.text()).not.toContain(TOKEN)
})
