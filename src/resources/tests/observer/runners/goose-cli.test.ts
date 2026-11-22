import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { runPlantedCheck } from '../../../observer/planted-check'
import { type TempStore, openTempStore } from '../test-support'
import { ObserverError, type ObserverPrompt } from '../../../observer/types'
import { createCliObserverRunner } from '../../../observer/runners/cli-core'
import { recordingSpawn } from './cli-test-support'
import { GOOSE_MIN_VERSION, GOOSE_PROVIDERS, gooseAdapter, parseGooseModel } from '../../../observer/runners/goose-cli'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-goose-cli-')
})
afterEach(() => temp.cleanup())

const RUN_DIR = '/data/observer/runs/run-abc'
const BASE_ENV = { PATH: '/usr/bin', HOME: '/Users/dev', KINFOLD_OBSERVER: '1' }
const SYSTEM = 'SYSTEM RULES FOR THE OBSERVER'
const PROMPT: ObserverPrompt = { system: SYSTEM, user: 'UNTRUSTED SESSION EVENTS', eventIds: ['01JA'] }
const MARKER = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

/** The shape goose 1.59.2 printed in a live run (trimmed): the user turn, one assistant text, run metadata. */
function output(assistant: unknown[], extra: { status?: string; advertised?: string[] | null } = {}): string {
  return JSON.stringify({
    messages: [
      { id: null, role: 'user', created: 1, content: [{ type: 'text', text: 'events' }], metadata: { userVisible: true, agentVisible: true } },
      {
        id: 'chatcmpl-1',
        role: 'assistant',
        created: 2,
        content: assistant,
        metadata: { inference: { provider: 'ollama', requestedModel: 'qwen2.5:1.5b' }, ...(extra.advertised === null ? {} : { operations: { llm: { advertised_tools: extra.advertised ?? ['load_skill'] } } }) },
      },
    ],
    metadata: { total_tokens: 671, input_tokens: 669, output_tokens: 2, status: extra.status ?? 'completed' },
  })
}
const text = (value: string) => ({ type: 'text', text: value })
const toolRequest = { type: 'toolRequest', id: 't1', toolCall: { status: 'success', value: { name: 'load_skill', arguments: { name: 'x' } } } }

function invocation(model = 'ollama/qwen2.5:1.5b') {
  return gooseAdapter.invocation({ binaryPath: '/opt/bin/goose', runDir: RUN_DIR, model, system: SYSTEM, title: 'kinfold-observer-1', env: BASE_ENV })
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

describe('invocation', () => {
  test('runs goose headless with no session, no profile extensions, JSON output and the prompt on stdin', () => {
    const { cmd, files } = invocation()
    expect(cmd).toEqual([
      '/opt/bin/goose', 'run', '-i', '-', '-q', '--no-session', '--no-profile', '--output-format', 'json',
      '--provider', 'ollama', '--model', 'qwen2.5:1.5b', '--system', SYSTEM,
    ])
    expect(cmd.join(' ')).not.toContain('UNTRUSTED')
    expect(files).toEqual([])
  })

  test('chat mode, telemetry off, and every goose folder (config, sessions, logs, plugins) inside the run folder', () => {
    const { env } = invocation()
    expect(env).toEqual({ ...BASE_ENV, GOOSE_PATH_ROOT: join(RUN_DIR, 'goose'), GOOSE_MODE: 'chat', GOOSE_TELEMETRY_ENABLED: 'false' })
    expect(gooseAdapter.isolatedEnv(RUN_DIR, BASE_ENV)).toEqual(env)
  })

  test('the keyring and a local Ollama address are the only extra variables passed through', () => {
    expect(gooseAdapter.extraEnv).toEqual(['OLLAMA_HOST', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'])
  })

  test('an OLLAMA_HOST across the network in plain http is refused, since session text would cross it in the clear', () => {
    const run = (host: string) => gooseAdapter.invocation({ binaryPath: '/opt/bin/goose', runDir: RUN_DIR, model: 'ollama/qwen2.5:1.5b', system: SYSTEM, title: 't', env: { ...BASE_ENV, OLLAMA_HOST: host } })
    for (const host of ['127.0.0.1:11434', 'http://localhost:11434', 'https://ollama.example.com']) expect(run(host).env.OLLAMA_HOST).toBe(host)
    for (const host of ['10.0.0.5:11434', 'http://10.0.0.5:11434']) {
      const error = caught(() => run(host))
      expect(error.errorClass).toBe('config_invalid')
      expect(error.detail).not.toContain('10.0.0.5')
    }
  })
})

describe('parseGooseModel', () => {
  test('splits <provider>/<model> at the first slash, so a model may hold slashes and colons', () => {
    expect(parseGooseModel('anthropic/claude-haiku-5-5')).toEqual({ ok: true, value: { provider: 'anthropic', model: 'claude-haiku-5-5' } })
    expect(parseGooseModel('openrouter/meta-llama/llama-4:free')).toEqual({ ok: true, value: { provider: 'openrouter', model: 'meta-llama/llama-4:free' } })
  })

  test('only providers that call a model over HTTP: a provider that wraps another agent would run tools goose cannot see', () => {
    expect(GOOSE_PROVIDERS).toEqual(['anthropic', 'openai', 'google', 'openrouter', 'xai', 'ollama', 'tetrate'])
    for (const wrapped of ['claude-code', 'codex', 'gemini-cli', 'cursor-agent', 'claude-acp'])
      expect(parseGooseModel(`${wrapped}/default`)).toEqual({ ok: false, error: `goose-cli models are <provider>/<model>, provider one of ${GOOSE_PROVIDERS.join(', ')}` })
  })

  test.each(['qwen2.5', '/m', 'ollama/', 'ollama/-x', 'ollama/a b'])('%s is refused', (model) => {
    expect(parseGooseModel(model).ok).toBe(false)
  })

  test('invocation refuses a model it cannot pass safely, without quoting it', () => {
    const error = caught(() => invocation('claude-code/sonnet'))
    expect(error.errorClass).toBe('config_invalid')
    expect(error.detail).not.toContain('sonnet')
  })
})

describe('parse', () => {
  test('reads the assistant text and the token counts of a live run', () => {
    expect(gooseAdapter.parse(output([text('OK')]))).toEqual({ text: 'OK', model: null, toolEvents: 0, sessionId: null, usage: { inputTokens: 669, outputTokens: 2 } })
  })

  test('joins several assistant texts and skips thinking', () => {
    expect(gooseAdapter.parse(output([{ type: 'thinking', thinking: 'hm', signature: 's' }, text('a'), text('b')])).text).toBe('ab')
  })

  test('counts every tool request, response or confirmation as a tool event, even a skipped load_skill', () => {
    const parsed = gooseAdapter.parse(output([text('x'), toolRequest, { type: 'toolResponse', id: 't1', toolResult: {} }, { type: 'toolConfirmationRequest', id: 't2' }, { type: 'frontendToolRequest', id: 't3' }, { type: 'actionRequired' }]))
    expect(parsed.toolEvents).toBe(5)
  })

  test('a tool advertised beyond load_skill means an extension loaded: every extra one counts as a tool event', () => {
    expect(gooseAdapter.parse(output([text('x')], { advertised: ['load_skill', 'developer__shell', 'memory__read'] })).toolEvents).toBe(2)
  })

  test.each([
    ['not JSON', 'nope', 'goose output is not JSON'],
    ['no messages', JSON.stringify({ metadata: {} }), 'goose output has no messages'],
    ['an unfinished run', output([text('x')], { status: 'max_turns' }), 'goose run did not complete'],
    ['an unknown content type', output([{ type: 'image', data: 'x' }]), 'goose output has a content item of an unknown type'],
    ['no assistant text', output([]), 'goose output has no assistant text'],
    ['an assistant turn that does not list the tools it was offered', output([text('x')], { advertised: null }), 'goose output does not say which tools the model was offered'],
  ])('%s is bad_response, never quoting the output', (_name, stdout, detail) => {
    const error = caught(() => gooseAdapter.parse(stdout))
    expect(error.errorClass).toBe('bad_response')
    expect(error.detail).toBe(detail)
  })
})

test('the version must be a bare goose version, so the database tool of the same name is not taken for it', () => {
  expect(gooseAdapter.parseVersion(' 1.59.2\n')).toEqual([1, 59, 2])
  expect(gooseAdapter.parseVersion('goose version: v3.24.1\n')).toBeNull()
  expect(GOOSE_MIN_VERSION).toEqual([1, 59, 0])
})

test('listModels lists nothing: goose has no command for it, and the question says what to type', async () => {
  expect(await gooseAdapter.listModels({ binaryPath: '/x', runDir: RUN_DIR, env: BASE_ENV, spawn: recordingSpawn([]) })).toEqual([])
})

describe('through the shared core', () => {
  const VERSION = { stdout: ' 1.59.2\n' }
  const runner = (answers: Parameters<typeof recordingSpawn>[0]) => {
    // Every run probes --version first.
    const spawn = recordingSpawn(answers.length === 0 ? [VERSION] : answers.flatMap((answer) => [VERSION, answer]))
    return { spawn, runner: createCliObserverRunner(gooseAdapter, { dataDir: temp.dataDir, model: 'ollama/qwen2.5:1.5b', spawn, which: () => '/opt/bin/goose', parentEnv: { PATH: '/usr/bin', HOME: '/Users/dev', OPENAI_API_KEY: 'sk-x' } }) }
  }

  test('a run gets the prompt on stdin, the stripped env, and leaves no goose folder behind', async () => {
    const { spawn, runner: r } = runner([{ stdout: output([text('{"observations":[]}')]) }])
    expect((await r.run(PROMPT)).text).toBe('{"observations":[]}')
    const run = spawn.requests[1]!
    expect(run.stdin).toBe(PROMPT.user)
    expect(run.env.OPENAI_API_KEY).toBeUndefined()
    expect(run.env.GOOSE_PATH_ROOT).toBe(join(run.cwd, 'goose'))
    expect(existsSync(run.cwd)).toBe(false)
  })

  test('the version probe runs in a run folder of its own with goose\'s folders there, so a probe logs nothing into HOME', async () => {
    const { spawn, runner: r } = runner([])
    expect(await r.probe()).toEqual({ version: '1.59.2', binaryPath: '/opt/bin/goose' })
    const probe = spawn.requests[0]!
    expect(probe.cmd).toEqual(['/opt/bin/goose', '--version'])
    expect(probe.env.GOOSE_PATH_ROOT).toBe(join(probe.cwd, 'goose'))
    expect(probe.cwd).toContain(join('observer', 'runs'))
    expect(existsSync(probe.cwd)).toBe(false)
  })

  test('a run that asked for a tool is refused as tool_attempt', async () => {
    const { runner: r } = runner([{ stdout: output([toolRequest, text('done')]) }])
    await expect(r.run(PROMPT)).rejects.toThrow('tool_attempt')
  })

  test('passes the planted-instruction check on a clean answer, and fails it on an echo or a tool request', async () => {
    const clean = runner([{ stdout: output([text('OK')]) }, { stdout: output([text('Nothing to report.')]) }])
    expect(await runPlantedCheck(clean.runner, () => MARKER)).toEqual({ ok: true })
    expect(clean.spawn.requests[3]!.stdin).toContain('notes.txt')
    expect(clean.spawn.requests[3]!.stdin).not.toContain(MARKER)
    const echo = runner([{ stdout: output([text('OK')]) }, { stdout: output([text(`It says ${MARKER}`)]) }])
    expect(await runPlantedCheck(echo.runner, () => MARKER)).toEqual({ ok: false, errorClass: 'safety_check_failed' })
    const tool = runner([{ stdout: output([text('OK')]) }, { stdout: output([toolRequest, text('x')]) }])
    expect(await runPlantedCheck(tool.runner, () => MARKER)).toEqual({ ok: false, errorClass: 'tool_attempt' })
  })
})
