import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CredentialProvider } from '../../secrets/credentials'
import { type TempStore, openTempStore } from '../test-support'
import { ObserverError, type ObserverPrompt, type ObserverSettings } from '../types'
import { createCliObserverRunner } from './cli-core'
import { recordingSpawn } from './cli-test-support'
import { CODEX_MIN_VERSION, codexAdapter, tomlBasicString } from './codex-cli'
import { createCliRunner, createRunner } from '.'
import { posixOnly } from '../../../test/platform-guards'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-codex-cli-')
})
afterEach(() => temp.cleanup())

const RUN_DIR = '/data/observer/runs/run-abc'
const BASE_ENV = { PATH: '/usr/bin', HOME: '/Users/dev', CODEX_HOME: '/Users/dev/.codex', KINFOLD_OBSERVER: '1' }
const SYSTEM = 'SYSTEM RULES FOR THE OBSERVER'
const USER_TEXT = 'UNTRUSTED SESSION EVENTS'
const PROMPT: ObserverPrompt = { system: SYSTEM, user: USER_TEXT, eventIds: ['01JA'] }
const SECRET = 'SECRET-MODEL-TEXT'

function invocation(runDir = RUN_DIR) {
  return codexAdapter.invocation({ binaryPath: '/opt/bin/codex', runDir, model: 'gpt-x', system: SYSTEM, title: 'kinfold-observer-1', env: BASE_ENV })
}

function jsonl(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

const THREAD = { type: 'thread.started', thread_id: 'thr_1' }
const TURN = { type: 'turn.started' }
const DONE = { type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 4, output_tokens: 30 } }
function message(text: string, id = 'item_m'): unknown {
  return { type: 'item.completed', item: { id, type: 'agent_message', text } }
}
function item(type: string, id: string, phase = 'item.completed'): unknown {
  return { type: phase, item: { id, type } }
}

function caught(fn: () => unknown): ObserverError {
  try {
    fn()
  } catch (error: unknown) {
    if (error instanceof ObserverError) return error
    throw error
  }
  throw new Error('expected an ObserverError')
}

async function caughtAsync(fn: () => Promise<unknown>): Promise<ObserverError> {
  try {
    await fn()
  } catch (error: unknown) {
    if (error instanceof ObserverError) return error
    throw error
  }
  throw new Error('expected an ObserverError')
}

// --- invocation ---------------------------------------------------------

test('invocation builds the exact codex exec argv, ending with - for stdin', () => {
  expect(invocation().cmd).toEqual([
    '/opt/bin/codex', 'exec',
    '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--strict-config',
    '-C', RUN_DIR,
    '-s', 'read-only',
    '-m', 'gpt-x',
    '--json',
    '--color', 'never',
    '-c', 'web_search="disabled"',
    '-c', 'features.shell_tool=false',
    '-c', 'features.view_image=false',
    '-c', 'features.apply_patch_freeform=false',
    '-c', 'features.plugins=false',
    '-c', 'features.apps=false',
    '-c', 'features.hooks=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.code_mode=false',
    '-c', 'features.memories=false',
    '-c', 'features.goals=false',
    '-c', `model_instructions_file="${RUN_DIR}/instructions.md"`,
    '-',
  ])
})

test('invocation plants the system prompt as instructions.md and keeps it out of argv', () => {
  const built = invocation()
  expect(built.files).toEqual([{ name: 'instructions.md', content: SYSTEM }])
  expect(built.cmd.some((arg) => arg.includes(SYSTEM))).toBe(false)
})

test('invocation env is exactly isolatedEnv(runDir, base), which is the base unchanged', () => {
  expect(invocation().env).toEqual(codexAdapter.isolatedEnv(RUN_DIR, BASE_ENV))
  expect(codexAdapter.isolatedEnv(RUN_DIR, BASE_ENV)).toEqual(BASE_ENV)
})

test('the adapter passes CODEX_HOME through and needs codex 0.166.0', () => {
  expect(codexAdapter.provider).toBe('codex-cli')
  expect(codexAdapter.binary).toBe('codex')
  expect(codexAdapter.extraEnv).toEqual(['CODEX_HOME'])
  expect(CODEX_MIN_VERSION).toEqual([0, 166, 0])
  expect(codexAdapter.minVersion).toEqual(CODEX_MIN_VERSION)
})

test('the instructions path is TOML-quoted, escaping quotes, backslashes and control characters', () => {
  expect(tomlBasicString('/a b/c')).toBe('"/a b/c"')
  expect(tomlBasicString('/a"b\\c')).toBe('"/a\\"b\\\\c"')
  expect(tomlBasicString('/a\nb\tc\u007f')).toBe('"/a\\nb\\tc\\u007F"')
  const odd = invocation('/data/we"ird\\dir').cmd
  expect(odd).toContain('model_instructions_file="/data/we\\"ird\\\\dir/instructions.md"')
})

test('a path that is not well-formed Unicode is refused without quoting it', () => {
  const error = caught(() => tomlBasicString('/data/\ud800x'))
  expect(error.errorClass).toBe('internal')
  expect(error.detail).not.toContain('/data')
})

// --- parse --------------------------------------------------------------

test('parse takes text from the last completed agent_message, ignores reasoning, reads thread id and usage', () => {
  const stdout = jsonl(
    THREAD, TURN,
    { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking' } },
    message('first', 'm1'),
    { type: 'item.updated', item: { id: 'm2', type: 'agent_message', text: 'partial' } },
    message('{"observations":[]}', 'm2'),
    DONE,
  )
  expect(codexAdapter.parse(stdout)).toEqual({
    text: '{"observations":[]}',
    model: null,
    toolEvents: 0,
    sessionId: 'thr_1',
    usage: { inputTokens: 120, outputTokens: 30 },
  })
})

test('parse leaves usage out when turn.completed has none', () => {
  const parsed = codexAdapter.parse(jsonl(THREAD, message('ok'), { type: 'turn.completed' }))
  expect(parsed.usage).toBeUndefined()
  expect(parsed.text).toBe('ok')
})

for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'frobnicate']) {
  test(`a ${type} item counts as one tool event`, () => {
    const parsed = codexAdapter.parse(jsonl(THREAD, item(type, 't1', 'item.started'), item(type, 't1'), message('ok'), DONE))
    expect(parsed.toolEvents).toBe(1)
  })
}

test('tool items without an id are each counted; distinct ids are counted separately', () => {
  const stdout = jsonl(
    { type: 'item.started', item: { type: 'command_execution' } },
    { type: 'item.completed', item: { type: 'command_execution' } },
    item('file_change', 'a'), item('file_change', 'b'), item('file_change', 'a', 'item.updated'),
    message('ok'),
  )
  expect(codexAdapter.parse(stdout).toolEvents).toBe(4)
})

test('an item event with no item type, or no item at all, counts as a tool event', () => {
  expect(codexAdapter.parse(jsonl({ type: 'item.completed', item: { id: 'x' } }, message('ok'))).toolEvents).toBe(1)
  expect(codexAdapter.parse(jsonl({ type: 'item.completed' }, message('ok'))).toolEvents).toBe(1)
})

test('an unknown top-level event type counts as a tool event; lifecycle types do not', () => {
  expect(codexAdapter.parse(jsonl(THREAD, { type: 'exec_command.begin' }, message('ok'), DONE)).toolEvents).toBe(1)
  expect(codexAdapter.parse(jsonl({ type: 42 }, message('ok'))).toolEvents).toBe(1)
  expect(codexAdapter.parse(jsonl(THREAD, TURN, message('ok'), DONE)).toolEvents).toBe(0)
})

test('turn.failed throws bad_response without quoting the error message', () => {
  const error = caught(() => codexAdapter.parse(jsonl(THREAD, message('ok'), { type: 'turn.failed', error: { message: SECRET } })))
  expect(error.errorClass).toBe('bad_response')
  expect(error.detail).not.toContain(SECRET)
})

test('an error event throws bad_response without quoting it', () => {
  const error = caught(() => codexAdapter.parse(jsonl(THREAD, { type: 'error', message: SECRET })))
  expect(error.errorClass).toBe('bad_response')
  expect(error.detail).not.toContain(SECRET)
})

test('output with no agent_message throws bad_response', () => {
  const error = caught(() => codexAdapter.parse(jsonl(THREAD, TURN, DONE)))
  expect(error.errorClass).toBe('bad_response')
})

test('a line that is not a JSON object throws bad_response without quoting it', () => {
  const error = caught(() => codexAdapter.parse(`${SECRET}\n${jsonl(message('ok'))}`))
  expect(error.errorClass).toBe('bad_response')
  expect(error.detail).not.toContain(SECRET)
  expect(caught(() => codexAdapter.parse(jsonl([1, 2], message('ok')))).errorClass).toBe('bad_response')
})

test('tool events are still reported when the output also failed, errored or was garbled', () => {
  expect(codexAdapter.parse(jsonl(item('command_execution', 'c1'), { type: 'turn.failed', error: { message: SECRET } })).toolEvents).toBe(1)
  expect(codexAdapter.parse(jsonl(item('command_execution', 'c1'), { type: 'error', message: SECRET })).toolEvents).toBe(1)
  expect(codexAdapter.parse(`garbage\n${jsonl(item('mcp_tool_call', 'c1'))}`).toolEvents).toBe(1)
})

// --- parseVersion -------------------------------------------------------

test('parseVersion reads codex-cli x.y.z and rejects anything else', () => {
  expect(codexAdapter.parseVersion('codex-cli 0.166.0\n')).toEqual([0, 166, 0])
  expect(codexAdapter.parseVersion('codex-cli 0.167.0-alpha.2\n')).toEqual([0, 167, 0])
  expect(codexAdapter.parseVersion('garbage')).toBeNull()
  expect(codexAdapter.parseVersion('')).toBeNull()
})

// --- listModels ---------------------------------------------------------

test('listModels runs codex debug models --bundled in the run folder and returns the slugs', async () => {
  const spawn = recordingSpawn([{ stdout: `${JSON.stringify({ models: [{ slug: 'gpt-x' }, { slug: 'gpt-y', display_name: 'Y' }, { slug: 'gpt-x' }] })}\n` }])
  const models = await codexAdapter.listModels({ binaryPath: '/opt/bin/codex', runDir: RUN_DIR, env: BASE_ENV, spawn })
  expect(models).toEqual(['gpt-x', 'gpt-y'])
  expect(spawn.requests).toHaveLength(1)
  expect(spawn.requests[0]!.cmd).toEqual(['/opt/bin/codex', 'debug', 'models', '--bundled'])
  expect(spawn.requests[0]!.cwd).toBe(RUN_DIR)
  expect(spawn.requests[0]!.env).toEqual(BASE_ENV)
  expect(spawn.requests[0]!.stdin).toBe('')
})

test('listModels throws bad_response on unparseable output, without quoting it', async () => {
  for (const stdout of [SECRET, JSON.stringify({ models: [] }), JSON.stringify({ models: [{ name: SECRET }] }), JSON.stringify([SECRET])]) {
    const spawn = recordingSpawn([{ stdout }])
    const error = await caughtAsync(() => codexAdapter.listModels({ binaryPath: '/opt/bin/codex', runDir: RUN_DIR, env: BASE_ENV, spawn }))
    expect(error.errorClass).toBe('bad_response')
    expect(error.detail).not.toContain(SECRET)
  }
})

test('listModels maps a failed or timed-out command by class, without stdout', async () => {
  const failed = await caughtAsync(() =>
    codexAdapter.listModels({ binaryPath: '/opt/bin/codex', runDir: RUN_DIR, env: BASE_ENV, spawn: recordingSpawn([{ exitCode: 2, stdout: SECRET }]) }),
  )
  expect(failed.errorClass).toBe('exit_nonzero')
  expect(failed.detail).not.toContain(SECRET)
  const slow = await caughtAsync(() =>
    codexAdapter.listModels({ binaryPath: '/opt/bin/codex', runDir: RUN_DIR, env: BASE_ENV, spawn: recordingSpawn([{ timedOut: true, exitCode: 143, stdout: SECRET }]) }),
  )
  expect(slow.errorClass).toBe('timeout')
  const missing = await caughtAsync(() =>
    codexAdapter.listModels({
      binaryPath: '/opt/bin/codex',
      runDir: RUN_DIR,
      env: BASE_ENV,
      spawn: async () => {
        throw Object.assign(new Error(SECRET), { code: 'ENOENT' })
      },
    }),
  )
  expect(missing.errorClass).toBe('cli_missing')
  expect(missing.detail).not.toContain(SECRET)
})

// --- through the core ---------------------------------------------------

const PARENT_ENV = { PATH: '/usr/bin', HOME: '/Users/dev', CODEX_HOME: '/Users/dev/.codex', OPENAI_API_KEY: 'sk-should-not-pass' }
const OK_RUN = jsonl(THREAD, TURN, message('{"observations":[]}'), DONE)

function coreRunner(spawn: ReturnType<typeof recordingSpawn>) {
  return createCliObserverRunner(codexAdapter, { dataDir: temp.dataDir, model: 'gpt-x', spawn, which: () => '/opt/bin/codex', parentEnv: PARENT_ENV })
}

test('a run through the core sends the user text on stdin only and returns text and usage', async () => {
  const spawn = recordingSpawn([{ stdout: 'codex-cli 0.166.0\n' }, { stdout: OK_RUN }])
  const result = await coreRunner(spawn).run(PROMPT)
  expect(result).toEqual({ text: '{"observations":[]}', model: 'gpt-x', usage: { inputTokens: 120, outputTokens: 30 } })
  const request = spawn.requests[1]!
  expect(request.stdin).toBe(USER_TEXT)
  expect(request.cmd.some((arg) => arg.includes(USER_TEXT))).toBe(false)
  expect(request.cmd.at(-1)).toBe('-')
  expect(request.cmd[request.cmd.indexOf('-C') + 1]).toBe(request.cwd)
  // A TOML string: a Windows folder's backslashes arrive escaped.
  expect(request.cmd).toContain(`model_instructions_file=${tomlBasicString(`${request.cwd}/instructions.md`)}`)
  expect(request.env.CODEX_HOME).toBe('/Users/dev/.codex')
  expect(request.env.OPENAI_API_KEY).toBeUndefined()
})

test('a run whose output shows a tool call is rejected as tool_attempt, even when codex exits 1', async () => {
  const toolRun = jsonl(THREAD, item('command_execution', 'c1'), message(SECRET), DONE)
  const ok = await caughtAsync(() => coreRunner(recordingSpawn([{ stdout: 'codex-cli 0.166.0\n' }, { stdout: toolRun }])).run(PROMPT))
  expect(ok.errorClass).toBe('tool_attempt')
  expect(ok.detail).not.toContain(SECRET)
  const failedRun = jsonl(THREAD, item('command_execution', 'c1'), { type: 'turn.failed', error: { message: SECRET } })
  const failed = await caughtAsync(() => coreRunner(recordingSpawn([{ stdout: 'codex-cli 0.166.0\n' }, { exitCode: 1, stdout: failedRun }])).run(PROMPT))
  expect(failed.errorClass).toBe('tool_attempt')
})

test('a codex older than 0.166.0 is refused before any run', async () => {
  const spawn = recordingSpawn([{ stdout: 'codex-cli 0.165.9\n' }])
  const error = await caughtAsync(() => coreRunner(spawn).run(PROMPT))
  expect(error.errorClass).toBe('config_invalid')
  expect(spawn.requests).toHaveLength(1)
})

// --- createCliRunner / createRunner ------------------------------------

const NO_CREDENTIALS: CredentialProvider = { get: () => null }

function settings(provider: ObserverSettings['provider']): ObserverSettings {
  return { provider, model: 'gpt-x', credentialRef: null, enabled: true, source: 'built-in' }
}

function fakeCodexOnPath(): string {
  const bin = join(temp.dataDir, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'codex')
  writeFileSync(path, '#!/bin/sh\nexit 99\n')
  chmodSync(path, 0o755)
  return bin
}

posixOnly('sh scripts')('createCliRunner builds the codex-cli runner with the deps spawn, env and data dir', async () => {
  const spawn = recordingSpawn([{ stdout: 'codex-cli 0.166.0\n' }, { stdout: OK_RUN }])
  const runner = createCliRunner(settings('codex-cli'), { dataDir: temp.dataDir, credentials: NO_CREDENTIALS, spawn, parentEnv: { PATH: fakeCodexOnPath(), CODEX_HOME: '/c' } })
  expect(typeof runner.probe).toBe('function')
  expect(typeof runner.listModels).toBe('function')
  const result = await runner.run(PROMPT)
  expect(result.text).toBe('{"observations":[]}')
  expect(spawn.requests[1]!.cmd[1]).toBe('exec')
  expect(spawn.requests[1]!.env.CODEX_HOME).toBe('/c')
})

test('createCliRunner refuses providers that are not CLI login observers with config_invalid', () => {
  for (const provider of ['claude-cli', 'openrouter'] as const) {
    const error = caught(() => createCliRunner(settings(provider), { dataDir: temp.dataDir, credentials: NO_CREDENTIALS }))
    expect(error.errorClass).toBe('config_invalid')
  }
})

posixOnly('sh scripts')('createRunner routes codex-cli through createCliRunner', async () => {
  const spawn = recordingSpawn([{ stdout: 'codex-cli 0.166.0\n' }, { stdout: OK_RUN }])
  const runner = createRunner(settings('codex-cli'), { dataDir: temp.dataDir, credentials: NO_CREDENTIALS, spawn, parentEnv: { PATH: fakeCodexOnPath() } })
  expect((await runner.run(PROMPT)).text).toBe('{"observations":[]}')
})
