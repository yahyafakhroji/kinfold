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
  [{ stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 429 rate_limit_error' }) }, 'rate_limited: claude reported an error: API Error: 429'],
])('a failed run %p is a named failure', async (result, message) => {
  const { spawn } = capture(result)
  expect(await failure(runner(spawn).run(PROMPT))).toStartWith(message)
})
