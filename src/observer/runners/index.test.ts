import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLAUDE_TOKEN_REF } from '../settings'
import type { ObserverSettings } from '../types'
import { createRunner } from '.'
import { ANTHROPIC_ENDPOINT, GEMINI_ENDPOINT } from './api'
import type { FetchFn } from './http-core'

const KEY = 'sk-test-fake-key-000000000000000000000000'
const PROMPT = { system: 's', user: 'u', eventIds: [] }

function deps(stored: Record<string, string>) {
  const refs: string[] = []
  const urls: string[] = []
  const auth: (string | undefined)[] = []
  const fetch: FetchFn = async (url, init) => {
    urls.push(url)
    const headers = init.headers as Record<string, string>
    auth.push(headers.authorization ?? headers['x-api-key'])
    return url === ANTHROPIC_ENDPOINT ? Response.json({ content: [{ type: 'text', text: 'ok' }] }) : Response.json({ choices: [{ message: { content: 'ok' } }] })
  }
  const credentials = { get: (ref: string) => (refs.push(ref), stored[ref] ?? null) }
  return { refs, urls, auth, value: { dataDir: '/nowhere', credentials, fetch } }
}

const settings = (provider: ObserverSettings['provider'], extra: Partial<ObserverSettings> = {}): ObserverSettings => ({ provider, model: 'm', credentialRef: null, enabled: true, source: 'host', ...extra })

test('each API provider reads its own key-store entry and calls its own endpoint', async () => {
  const d = deps({ anthropic: KEY, gemini: KEY })
  await createRunner(settings('anthropic-api'), d.value).run(PROMPT)
  await createRunner(settings('gemini-api'), d.value).run(PROMPT)
  expect(d.refs).toEqual(['anthropic', 'gemini'])
  expect(d.urls).toEqual([ANTHROPIC_ENDPOINT, GEMINI_ENDPOINT])
  expect(d.auth).toEqual([KEY, `Bearer ${KEY}`])
})

test('the OpenAI-compatible endpoint reads no key unless its row names one', async () => {
  const d = deps({ groq: KEY })
  await createRunner(settings('openai-compatible', { endpoint: 'http://127.0.0.1:11434/v1' }), d.value).run(PROMPT)
  await createRunner(settings('openai-compatible', { endpoint: 'https://api.groq.com/openai/v1', credentialRef: 'groq' }), d.value).run(PROMPT)
  expect(d.refs).toEqual(['groq'])
  expect(d.urls).toEqual(['http://127.0.0.1:11434/v1/chat/completions', 'https://api.groq.com/openai/v1/chat/completions'])
  expect(d.auth).toEqual([undefined, `Bearer ${KEY}`])
})

test('a missing key stops the build before any request', () => {
  const d = deps({})
  expect(() => createRunner(settings('qwen-api', { endpoint: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' }), d.value)).toThrow('credential_missing: no keychain entry for dashscope')
  expect(d.urls).toEqual([])
})

test('claude-cli reads its long-lived token from the key store for each run, and runs on the CLI login without one', async () => {
  const requests: Record<string, string>[] = []
  const spawn = async (request: { env: Readonly<Record<string, string>> }) => {
    requests.push({ ...request.env })
    return { exitCode: 0, timedOut: false, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok' }) }
  }
  const stored: Record<string, string> = {}
  const refs: string[] = []
  const value = { dataDir: mkdtempSync(join(tmpdir(), 'kinfold-runner-token-')), credentials: { get: (ref: string) => (refs.push(ref), stored[ref] ?? null) }, spawn, parentEnv: { PATH: '/usr/bin' } }
  try {
    const runner = createRunner(settings('claude-cli'), { ...value, which: () => '/opt/bin/claude' } as never)
    await runner.run(PROMPT)
    stored[CLAUDE_TOKEN_REF] = 'tok-fake'
    await runner.run(PROMPT)
    expect(refs).toEqual([CLAUDE_TOKEN_REF, CLAUDE_TOKEN_REF])
    expect(requests.map((env) => env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([undefined, 'tok-fake'])
  } finally {
    rmSync(value.dataDir, { recursive: true, force: true })
  }
})

test('a key store that cannot be read stops a claude-cli run as credential_error, never a silent switch to the login', async () => {
  const credentials = { get: (): string | null => { throw new Error('locked') } }
  const runner = createRunner(settings('claude-cli'), { dataDir: '/nowhere', credentials, which: () => '/opt/bin/claude', spawn: async () => { throw new Error('not reached') } } as never)
  await expect(runner.run(PROMPT)).rejects.toMatchObject({ errorClass: 'credential_error' })
})
