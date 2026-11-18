import { afterEach, beforeEach, expect, test } from 'bun:test'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { type TempStore, openTempStore } from '../test-support'
import { ObserverError, type ObserverPrompt } from '../types'
import { type SpawnFn, type SpawnRequest, createClaudeCliRunner } from './claude-cli'
import { posixOnly } from '../../../test/platform-guards'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-cli-')
})
afterEach(() => temp.cleanup())

const PROMPT: ObserverPrompt = { system: 'SYSTEM RULES', user: 'EVENTS', eventIds: ['01JA'] }
const PARENT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/dev',
  USER: 'dev',
  TMPDIR: '/tmp/x',
  ANTHROPIC_API_KEY: 'sk-ant-should-not-pass',
  OPENROUTER_API_KEY: 'sk-or-should-not-pass',
  KINFOLD_DATA_DIR: '/elsewhere',
}

const CLI_RESULT = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: '{"observations":[],"summary":null}',
  usage: { input_tokens: 12, output_tokens: 34 },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 12 } },
})

function capture(result: { exitCode?: number; stdout?: string; timedOut?: boolean; stderr?: string } = {}): { spawn: SpawnFn; requests: SpawnRequest[] } {
  const requests: SpawnRequest[] = []
  const spawn: SpawnFn = async (request) => {
    requests.push(request)
    return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? CLI_RESULT, timedOut: result.timedOut ?? false, ...(result.stderr === undefined ? {} : { stderr: result.stderr }) }
  }
  return { spawn, requests }
}

function runner(spawn: SpawnFn, which: (command: string) => string | null = () => '/opt/bin/claude') {
  return createClaudeCliRunner({ dataDir: temp.dataDir, model: 'haiku', spawn, which, parentEnv: PARENT_ENV })
}

test('spawns claude in print mode with haiku, no tools, no settings, no MCP and no saved session', async () => {
  const { spawn, requests } = capture()
  await runner(spawn).run(PROMPT)
  expect(requests[0]!.cmd).toEqual([
    '/opt/bin/claude', '--print', '--model', 'haiku', '--output-format', 'json', '--tools', '', '--setting-sources', '',
    '--strict-mcp-config', '--no-session-persistence', '--disable-slash-commands', '--system-prompt', 'SYSTEM RULES',
  ])
  expect(requests[0]!.stdin).toBe('EVENTS')
})

test('the child gets a minimal env with KINFOLD_OBSERVER=1 (and SAM_OBSERVER=1 for old hook code) and no API keys', async () => {
  const { spawn, requests } = capture()
  await runner(spawn).run(PROMPT)
  expect(requests[0]!.env).toEqual({ PATH: '/usr/bin:/bin', HOME: '/Users/dev', USER: 'dev', TMPDIR: '/tmp/x', KINFOLD_OBSERVER: '1', SAM_OBSERVER: '1' })
})

posixOnly('file modes')('the child runs in <dataDir>/observer, created 0700, never a project folder', async () => {
  const { spawn, requests } = capture()
  await runner(spawn).run(PROMPT)
  expect(requests[0]!.cwd).toBe(join(temp.dataDir, 'observer'))
  expect(statSync(requests[0]!.cwd).mode & 0o777).toBe(0o700)
})

test('the result text, the answering model and token usage come back', async () => {
  const { spawn } = capture()
  expect(await runner(spawn).run(PROMPT)).toEqual({
    text: '{"observations":[],"summary":null}',
    model: 'claude-haiku-5-5',
    usage: { inputTokens: 12, outputTokens: 34 },
  })
})

async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run
  } catch (error: unknown) {
    if (error instanceof ObserverError) return error.message
    throw error
  }
  throw new Error('expected a failure')
}

test('no claude on PATH is cli_missing and nothing is spawned', async () => {
  const { spawn, requests } = capture()
  expect(await failure(runner(spawn, () => null).run(PROMPT))).toStartWith('cli_missing')
  expect(requests).toEqual([])
})

test('a spawn ENOENT is cli_missing', async () => {
  const spawn: SpawnFn = async () => {
    throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
  }
  expect(await failure(runner(spawn).run(PROMPT))).toStartWith('cli_missing')
})

test.each([
  [{ exitCode: 1 }, 'exit_nonzero: claude exited 1'],
  [{ timedOut: true, exitCode: 143 }, 'timeout'],
  [{ stdout: 'login expired' }, 'bad_response: claude output is not JSON'],
  [{ stdout: JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true }) }, 'bad_response: claude reported error_max_turns'],
  [{ exitCode: 1, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Failed to authenticate: OAuth session expired and could not be refreshed' }) },
    'auth_expired: claude exited 1: Failed to authenticate: OAuth session expired and could not be refreshed'],
  [{ exitCode: 1, stderr: 'Not logged in · Please run /login\n' }, 'not_logged_in: claude exited 1: Not logged in'],
  // The hub's exact output: no type or subtype, spaces after the colons.
  [{ exitCode: 1, stdout: '{"is_error": true, "result": "Failed to authenticate: OAuth session expired and could not be refreshed"}' },
    'auth_expired: claude exited 1: Failed to authenticate: OAuth session expired and could not be refreshed'],
  [{ exitCode: 1, stdout: `Warning: notice\n${JSON.stringify([{ type: 'system' }, { type: 'result', is_error: true, result: 'Invalid API key · Please run /login' }])}` },
    'not_logged_in: claude exited 1: Invalid API key'],
  [{ stdout: JSON.stringify([{ type: 'system' }, { type: 'result', subtype: 'success', is_error: true, result: 'OAuth session expired and could not be refreshed' }]) },
    'auth_expired: claude reported an error: OAuth session expired'],
  [{ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 429 rate_limit_error' }) }, 'rate_limited: claude reported an error: API Error: 429'],
])('a failed run %p is a named failure', async (result, message) => {
  const { spawn } = capture(result)
  expect(await failure(runner(spawn).run(PROMPT))).toStartWith(message)
})

const TOKEN = 'sk-ant-oat01-FAKE-TEST-TOKEN-0000000000'

test('a long-lived token goes to the child in CLAUDE_CODE_OAUTH_TOKEN only: never in argv, never from the parent', async () => {
  const { spawn, requests } = capture()
  const withToken = createClaudeCliRunner({ dataDir: temp.dataDir, model: 'haiku', spawn, which: () => '/opt/bin/claude', parentEnv: { ...PARENT_ENV, CLAUDE_CODE_OAUTH_TOKEN: 'parent-token' }, oauthToken: () => TOKEN })
  await withToken.run(PROMPT)
  expect(requests[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
  expect(requests[0]!.cmd.join(' ')).not.toContain(TOKEN)
  expect(requests[0]!.stdin).not.toContain(TOKEN)
  const noToken = createClaudeCliRunner({ dataDir: temp.dataDir, model: 'haiku', spawn, which: () => '/opt/bin/claude', parentEnv: { ...PARENT_ENV, CLAUDE_CODE_OAUTH_TOKEN: 'parent-token' }, oauthToken: () => null })
  await noToken.run(PROMPT)
  expect(requests[1]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
})

test('a token is read for each run, so one saved or removed later applies to the next batch', async () => {
  const { spawn, requests } = capture()
  let stored: string | null = null
  const run = createClaudeCliRunner({ dataDir: temp.dataDir, model: 'haiku', spawn, which: () => '/opt/bin/claude', parentEnv: PARENT_ENV, oauthToken: () => stored })
  await run.run(PROMPT)
  stored = TOKEN
  await run.run(PROMPT)
  expect(requests.map((request) => request.env.CLAUDE_CODE_OAUTH_TOKEN)).toEqual([undefined, TOKEN])
})

test('an expired token fails as auth_expired and says the token is what expired, without the token', async () => {
  const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Failed to authenticate: OAuth token has expired' })
  const { spawn } = capture({ exitCode: 1, stdout })
  const run = createClaudeCliRunner({ dataDir: temp.dataDir, model: 'haiku', spawn, which: () => '/opt/bin/claude', parentEnv: PARENT_ENV, oauthToken: () => TOKEN })
  const message = await failure(run.run(PROMPT))
  expect(message).toStartWith('auth_expired: claude exited 1 (long-lived token): Failed to authenticate')
  expect(message).not.toContain(TOKEN)
})
