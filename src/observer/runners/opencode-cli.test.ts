import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CredentialProvider } from '../../secrets/credentials'
import { type TempStore, openTempStore } from '../test-support'
import { ObserverError, type ObserverPrompt, type ObserverSettings } from '../types'
import { type CliRunContext, createCliObserverRunner } from './cli-core'
import type { SpawnFn, SpawnRequest } from './claude-cli'
import { recordingSpawn } from './cli-test-support'
import { OBSERVER_AGENT, OPENCODE_MIN_VERSION, opencodeAdapter } from './opencode-cli'
import { createCliRunner, createRunner } from '.'

let temp: TempStore
let runDir: string
beforeEach(() => {
  temp = openTempStore('kinfold-opencode-cli-')
  runDir = join(temp.root, 'run-abc')
  mkdirSync(runDir, { mode: 0o700 })
})
afterEach(() => temp.cleanup())

const BIN = '/opt/bin/opencode'
const TITLE = 'kinfold-observer-0123456789abcdef'
const BASE_ENV = { PATH: '/usr/bin', HOME: '/Users/dev', XDG_DATA_HOME: '/Users/dev/.local/share', KINFOLD_OBSERVER: '1' }
const SYSTEM = 'SYSTEM RULES FOR THE OBSERVER'
const USER_TEXT = 'UNTRUSTED SESSION EVENTS'
const PROMPT: ObserverPrompt = { system: SYSTEM, user: USER_TEXT, eventIds: ['01JA'] }
const SECRET = 'SECRET-MODEL-TEXT'

function invocation(system = SYSTEM, model = 'anthropic/claude-x') {
  return opencodeAdapter.invocation({ binaryPath: BIN, runDir, model, system, title: TITLE, env: BASE_ENV })
}

function ndjson(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

const STEP_START = { type: 'step_start', sessionID: 'ses_1', timestamp: 1, part: { type: 'step-start' } }
const STEP_FINISH = { type: 'step_finish', sessionID: 'ses_1', timestamp: 4, part: { type: 'step-finish' } }
function text(value: string, sessionID = 'ses_1'): unknown {
  return { type: 'text', sessionID, timestamp: 2, part: { type: 'text', text: value } }
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

test('invocation builds the exact opencode run argv, with no --auto, --server or --continue', () => {
  const { cmd, files } = invocation()
  expect(cmd).toEqual([BIN, 'run', '--standalone', '--agent', 'kinfold-observer', '--model', 'anthropic/claude-x', '--format', 'json', '--title', TITLE])
  for (const flag of ['--auto', '--server', '--continue', '-c', '--session', '-s', '--fork']) expect(cmd).not.toContain(flag)
  expect(cmd.some((arg) => arg.includes(SYSTEM))).toBe(false)
  expect(files).toEqual([])
  expect(OBSERVER_AGENT).toBe('kinfold-observer')
})

test('invocation env redirects the config dir to an empty 0700 folder and sets the disable flags', () => {
  const { env } = invocation()
  const configDir = join(runDir, 'config')
  expect(env.OPENCODE_CONFIG_DIR).toBe(configDir)
  expect(existsSync(configDir)).toBe(true)
  expect(readdirSync(configDir)).toEqual([])
  expect(statSync(configDir).mode & 0o777).toBe(0o700)
  expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
  expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1')
  expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
  expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1')
  expect(env.PATH).toBe('/usr/bin')
  expect(env.XDG_DATA_HOME).toBe('/Users/dev/.local/share')
})

test('OPENCODE_CONFIG_CONTENT defines the deny-all observer agent and the deny policies', () => {
  const config = JSON.parse(invocation().env.OPENCODE_CONFIG_CONTENT!)
  expect(config.default_agent).toBe('kinfold-observer')
  expect(config.share).toBe('disabled')
  expect(config.update).toBe('disable')
  expect(config.snapshots).toBe(false)
  expect(config.policies).toEqual([
    { action: 'tool.use', resource: '*', effect: 'deny' },
    { action: 'integration.use', resource: 'mcp:*', effect: 'deny' },
  ])
  const agent = config.agents['kinfold-observer']
  expect(agent.mode).toBe('primary')
  expect(agent.system).toBe(SYSTEM)
  expect(agent.permissions.at(-1)).toEqual({ action: '*', resource: '*', effect: 'deny' })
  expect(config.plugins).toBeUndefined()
  expect(config.mcp).toBeUndefined()
})

test('isolatedEnv returns a new object with the redirect, flags and config, leaving baseEnv untouched', () => {
  const base = { ...BASE_ENV }
  const env = opencodeAdapter.isolatedEnv(runDir, base)
  expect(env).not.toBe(base)
  expect(base).toEqual(BASE_ENV)
  expect(env.OPENCODE_CONFIG_DIR).toBe(join(runDir, 'config'))
  expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
  expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1')
  expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
  expect(env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1')
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!)
  expect(config.policies[0]).toEqual({ action: 'tool.use', resource: '*', effect: 'deny' })
  expect(config.agents['kinfold-observer'].permissions.at(-1)).toEqual({ action: '*', resource: '*', effect: 'deny' })
  const { OPENCODE_CONFIG_CONTENT: _a, ...invocationRest } = invocation().env
  const { OPENCODE_CONFIG_CONTENT: _b, ...isolatedRest } = env
  expect(invocationRest).toEqual(isolatedRest)
})

test('the run env overrides any OPENCODE_* value already in the base env', () => {
  const env = opencodeAdapter.isolatedEnv(runDir, { ...BASE_ENV, OPENCODE_CONFIG_DIR: '/Users/dev/.config/opencode', OPENCODE_DISABLE_PROJECT_CONFIG: '0' })
  expect(env.OPENCODE_CONFIG_DIR).toBe(join(runDir, 'config'))
  expect(env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
})

test('a system prompt holding {env: or {file: throws internal before anything is built', () => {
  for (const system of ['use {env:HOME} here', 'read {file:~/.ssh/id_rsa}']) {
    const error = caught(() => invocation(system))
    expect(error.errorClass).toBe('internal')
    expect(error.detail).not.toContain('HOME')
    expect(error.detail).not.toContain('ssh')
  }
})

test('a model that looks like a flag is refused as config_invalid', () => {
  const error = caught(() => invocation(SYSTEM, '--auto'))
  expect(error.errorClass).toBe('config_invalid')
  expect(error.detail).not.toContain('--auto')
})

// --- parse --------------------------------------------------------------

test('parse joins the text parts, takes the first session id, and ignores reasoning and steps', () => {
  const stdout = ndjson(
    { type: 'step_start', timestamp: 0, part: {} },
    STEP_START,
    { type: 'reasoning', sessionID: 'ses_1', part: { type: 'reasoning', text: SECRET } },
    text('{"observations":'),
    text('[]}', 'ses_other'),
    STEP_FINISH,
  )
  expect(opencodeAdapter.parse(stdout)).toEqual({ text: '{"observations":[]}', model: null, toolEvents: 0, sessionId: 'ses_1' })
})

test('parse counts tool_use and unknown types as tool events and returns them instead of throwing', () => {
  const tools = opencodeAdapter.parse(ndjson(STEP_START, { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'bash' } }, text(SECRET), { type: 'patch', sessionID: 'ses_1' }, STEP_FINISH))
  expect(tools.toolEvents).toBe(2)
  expect(tools.sessionId).toBe('ses_1')
  const typeless = opencodeAdapter.parse(ndjson(STEP_START, { sessionID: 'ses_1' }, text('x')))
  expect(typeless.toolEvents).toBe(1)
})

test('parse throws bad_response on an error event, but a tool event seen anywhere wins', () => {
  const error = caught(() => opencodeAdapter.parse(ndjson(STEP_START, { type: 'error', sessionID: 'ses_1', error: { message: SECRET } })))
  expect(error.errorClass).toBe('bad_response')
  expect(error.detail).not.toContain(SECRET)
  const withTool = opencodeAdapter.parse(ndjson({ type: 'error', sessionID: 'ses_1', error: { message: SECRET } }, { type: 'tool_use', sessionID: 'ses_1' }))
  expect(withTool.toolEvents).toBe(1)
})

test('parse throws bad_response on garbled or empty output without quoting it', () => {
  for (const stdout of [`${SECRET}\n`, ndjson(STEP_START, STEP_FINISH), ndjson([SECRET]), ndjson({ type: 'text', sessionID: 'ses_1', part: { text: 7 } }), '']) {
    const error = caught(() => opencodeAdapter.parse(stdout))
    expect(error.errorClass).toBe('bad_response')
    expect(error.detail).not.toContain(SECRET)
  }
  const garbledWithTool = opencodeAdapter.parse(`${SECRET}\n${JSON.stringify({ type: 'tool_use' })}\n`)
  expect(garbledWithTool.toolEvents).toBe(1)
})

test('parse ignores a session id that is not a plain id', () => {
  const parsed = opencodeAdapter.parse(ndjson(text('a', '--server=http://x'), text('b', 'ses_2')))
  expect(parsed.sessionId).toBe('ses_2')
  expect(opencodeAdapter.parse(ndjson(text('a', '')))).toMatchObject({ sessionId: null })
})

// --- version ------------------------------------------------------------

test('parseVersion reads opencode v2.1.4 and the minimum is 2.0.0', () => {
  expect(opencodeAdapter.parseVersion('opencode v2.1.4\n')).toEqual([2, 1, 4])
  expect(opencodeAdapter.parseVersion('2.0.1\n')).toEqual([2, 0, 1])
  expect(opencodeAdapter.parseVersion('opencode\n')).toBeNull()
  expect(OPENCODE_MIN_VERSION).toEqual([2, 0, 0])
  expect(opencodeAdapter.minVersion).toBe(OPENCODE_MIN_VERSION)
  expect(opencodeAdapter.extraEnv).toEqual(['XDG_DATA_HOME', 'OPENCODE_DB'])
  expect(opencodeAdapter.binary).toBe('opencode')
  expect(opencodeAdapter.provider).toBe('opencode-cli')
})

// --- cleanup ------------------------------------------------------------

function cleanupCtx(spawn: CliRunContext['spawn'], sessionId: string | null, env = invocation().env): CliRunContext {
  return { binaryPath: BIN, runDir, env, title: TITLE, sessionId, spawn }
}

test('cleanup with a session id deletes it by id with the same env and cwd', async () => {
  const env = invocation().env
  const spawn = recordingSpawn([{}])
  await opencodeAdapter.cleanup!(cleanupCtx(spawn, 'ses_1', env))
  expect(spawn.requests).toHaveLength(1)
  expect(spawn.requests[0]!.cmd).toEqual([BIN, 'session', 'delete', '--standalone', 'ses_1'])
  expect(spawn.requests[0]!.env).toBe(env)
  expect(spawn.requests[0]!.cwd).toBe(runDir)
  expect(spawn.requests[0]!.stdin).toBe('')
})

test('cleanup with no session id lists sessions and deletes only exact title matches', async () => {
  const env = invocation().env
  const listed = JSON.stringify([
    { id: 'ses_a', title: TITLE },
    { id: 'ses_b', title: `${TITLE} ` },
    { id: 'ses_c', title: `${TITLE}x` },
    { id: 'ses_d', title: 'kinfold-observer-0123456789abcde' },
    { id: 'ses_e', title: TITLE.toUpperCase() },
    { id: 'ses_f', title: 'my real work' },
    { id: 'ses_g', title: TITLE },
    { id: '--server=http://x', title: TITLE },
    { title: TITLE },
  ])
  const spawn = recordingSpawn([{ stdout: listed }, {}, {}])
  await opencodeAdapter.cleanup!(cleanupCtx(spawn, null, env))
  expect(spawn.requests.map((request) => request.cmd)).toEqual([
    [BIN, 'session', 'list', '--standalone', '--format', 'json'],
    [BIN, 'session', 'delete', '--standalone', 'ses_a'],
    [BIN, 'session', 'delete', '--standalone', 'ses_g'],
  ])
  for (const request of spawn.requests) {
    expect(request.env).toBe(env)
    expect(request.cwd).toBe(runDir)
  }
})

test('cleanup reads a session list wrapped in an object, and deletes nothing when no title matches', async () => {
  const spawn = recordingSpawn([{ stdout: JSON.stringify({ sessions: [{ id: 'ses_z', title: 'other' }] }) }])
  await opencodeAdapter.cleanup!(cleanupCtx(spawn, null))
  expect(spawn.requests).toHaveLength(1)
})

test('cleanup spawns nothing when the run never built its config folder', async () => {
  const spawn = recordingSpawn([])
  await opencodeAdapter.cleanup!(cleanupCtx(spawn, null, opencodeAdapter.isolatedEnv(runDir, BASE_ENV)))
  expect(spawn.requests).toHaveLength(0)
})

test('cleanup failures throw fixed details that never quote output', async () => {
  const env = invocation().env
  const cases: Array<{ answers: Parameters<typeof recordingSpawn>[0]; sessionId: string | null; errorClass: string }> = [
    { answers: [{ exitCode: 1, stdout: SECRET }], sessionId: 'ses_1', errorClass: 'exit_nonzero' },
    { answers: [{ timedOut: true, exitCode: 143, stdout: SECRET }], sessionId: 'ses_1', errorClass: 'timeout' },
    { answers: [{ stdout: SECRET }], sessionId: null, errorClass: 'bad_response' },
    { answers: [{ stdout: JSON.stringify({ secret: SECRET }) }], sessionId: null, errorClass: 'bad_response' },
    { answers: [{ exitCode: 2, stdout: SECRET }], sessionId: null, errorClass: 'exit_nonzero' },
    { answers: [{ stdout: JSON.stringify([{ id: 'ses_a', title: TITLE }]) }, { exitCode: 1, stdout: SECRET }], sessionId: null, errorClass: 'exit_nonzero' },
  ]
  for (const { answers, sessionId, errorClass } of cases) {
    const error = await caughtAsync(() => opencodeAdapter.cleanup!(cleanupCtx(recordingSpawn(answers), sessionId, env)))
    expect(error.errorClass).toBe(errorClass as ObserverError['errorClass'])
    expect(error.detail).not.toContain(SECRET)
    expect(error.detail).not.toContain(SYSTEM)
  }
})

test('cleanup still tries every matching session when one delete fails', async () => {
  const listed = JSON.stringify([{ id: 'ses_a', title: TITLE }, { id: 'ses_b', title: TITLE }])
  const spawn = recordingSpawn([{ stdout: listed }, { exitCode: 1 }, {}])
  const error = await caughtAsync(() => opencodeAdapter.cleanup!(cleanupCtx(spawn, null)))
  expect(error.errorClass).toBe('exit_nonzero')
  expect(spawn.requests.map((request) => request.cmd.at(-1))).toEqual(['json', 'ses_a', 'ses_b'])
})

// --- listModels ---------------------------------------------------------

test('listModels runs opencode models --standalone in the run folder and returns non-empty trimmed lines', async () => {
  const env = opencodeAdapter.isolatedEnv(runDir, BASE_ENV)
  const spawn = recordingSpawn([{ stdout: 'anthropic/claude-x\n\n  openai/gpt-y  \nopencode/free#high\n' }])
  const models = await opencodeAdapter.listModels({ binaryPath: BIN, runDir, env, spawn })
  expect(models).toEqual(['anthropic/claude-x', 'openai/gpt-y', 'opencode/free#high'])
  expect(spawn.requests[0]!.cmd).toEqual([BIN, 'models', '--standalone'])
  expect(spawn.requests[0]!.env).toBe(env)
  expect(spawn.requests[0]!.cwd).toBe(runDir)
  expect(existsSync(join(runDir, 'config'))).toBe(true)
})

test('listModels failures throw fixed details that never quote output', async () => {
  const env = opencodeAdapter.isolatedEnv(runDir, BASE_ENV)
  const list = (spawn: CliRunContext['spawn']) => opencodeAdapter.listModels({ binaryPath: BIN, runDir, env, spawn })
  const failed = await caughtAsync(() => list(recordingSpawn([{ exitCode: 1, stdout: SECRET }])))
  expect(failed.errorClass).toBe('exit_nonzero')
  expect(failed.detail).not.toContain(SECRET)
  const slow = await caughtAsync(() => list(recordingSpawn([{ timedOut: true, exitCode: 143, stdout: SECRET }])))
  expect(slow.errorClass).toBe('timeout')
  const empty = await caughtAsync(() => list(recordingSpawn([{ stdout: '\n  \n' }])))
  expect(empty.errorClass).toBe('bad_response')
  const missing = await caughtAsync(() =>
    list(async () => {
      throw Object.assign(new Error(SECRET), { code: 'ENOENT' })
    }),
  )
  expect(missing.errorClass).toBe('cli_missing')
  expect(missing.detail).not.toContain(SECRET)
})

// --- through the core ---------------------------------------------------

const PARENT_ENV = { PATH: '/usr/bin', HOME: '/Users/dev', XDG_DATA_HOME: '/x/share', OPENCODE_DB: 'other.db', ANTHROPIC_API_KEY: 'sk-should-not-pass', OPENCODE_CONFIG_DIR: '/Users/dev/.config/opencode' }
const VERSION_OK = { stdout: 'opencode v2.1.4\n' }
const OK_RUN = ndjson(STEP_START, text('{"observations":[]}'), STEP_FINISH)

function coreRunner(spawn: SpawnFn, log?: (line: string) => void) {
  return createCliObserverRunner(opencodeAdapter, {
    dataDir: temp.dataDir,
    model: 'anthropic/claude-x',
    spawn,
    which: () => BIN,
    parentEnv: PARENT_ENV,
    ...(log !== undefined ? { log } : {}),
  })
}

test('a run through the core sends the user text on stdin only and deletes its session after', async () => {
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_RUN }, {}])
  const result = await coreRunner(spawn).run(PROMPT)
  expect(result).toEqual({ text: '{"observations":[]}', model: 'anthropic/claude-x' })
  const run = spawn.requests[1]!
  expect(run.stdin).toBe(USER_TEXT)
  expect(run.cmd.some((arg) => arg.includes(USER_TEXT))).toBe(false)
  expect(Object.values(run.env).some((value) => value.includes(USER_TEXT))).toBe(false)
  expect(run.env.OPENCODE_CONFIG_DIR).toBe(join(run.cwd, 'config'))
  expect(run.env.XDG_DATA_HOME).toBe('/x/share')
  expect(run.env.OPENCODE_DB).toBe('other.db')
  expect(run.env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(run.env.KINFOLD_OBSERVER).toBe('1')
  const title = run.cmd[run.cmd.indexOf('--title') + 1]
  expect(title).toMatch(/^kinfold-observer-[0-9a-f]{16}$/)
  const del = spawn.requests[2]!
  expect(del.cmd).toEqual([BIN, 'session', 'delete', '--standalone', 'ses_1'])
  expect(del.env).toEqual(run.env)
  expect(del.cwd).toBe(run.cwd)
  expect(existsSync(run.cwd)).toBe(false)
})

test('a timed-out run lists sessions and deletes the one with its title', async () => {
  const requests: SpawnRequest[] = []
  const titleOfRun = (): string => requests[1]!.cmd[requests[1]!.cmd.indexOf('--title') + 1]!
  const spawn: SpawnFn = async (request) => {
    requests.push(request)
    if (requests.length === 1) return { exitCode: 0, timedOut: false, stdout: 'opencode v2.1.4\n' }
    if (requests.length === 2) return { exitCode: 143, timedOut: true, stdout: SECRET }
    if (request.cmd.includes('list')) return { exitCode: 0, timedOut: false, stdout: JSON.stringify([{ id: 'ses_t', title: titleOfRun() }, { id: 'ses_u', title: 'mine' }]) }
    return { exitCode: 0, timedOut: false, stdout: '' }
  }
  const error = await caughtAsync(() => coreRunner(spawn).run(PROMPT))
  expect(error.errorClass).toBe('timeout')
  expect(requests.map((request) => request.cmd.slice(1))).toEqual([
    ['--version'],
    expect.arrayContaining(['run']),
    ['session', 'list', '--standalone', '--format', 'json'],
    ['session', 'delete', '--standalone', 'ses_t'],
  ])
  expect(requests[2]!.env).toEqual(requests[1]!.env)
})

test('a tool_use event rejects the run as tool_attempt, even when opencode exits 1, and the session is still deleted', async () => {
  const toolRun = ndjson(STEP_START, { type: 'tool_use', sessionID: 'ses_1', part: { tool: 'read' } }, text(SECRET), STEP_FINISH)
  const spawn = recordingSpawn([VERSION_OK, { stdout: toolRun }, {}])
  const ok = await caughtAsync(() => coreRunner(spawn).run(PROMPT))
  expect(ok.errorClass).toBe('tool_attempt')
  expect(ok.detail).not.toContain(SECRET)
  expect(spawn.requests[2]!.cmd).toEqual([BIN, 'session', 'delete', '--standalone', 'ses_1'])
  const failedRun = ndjson(STEP_START, { type: 'tool_use', sessionID: 'ses_1' }, { type: 'error', sessionID: 'ses_1', error: { message: SECRET } })
  const failed = await caughtAsync(() => coreRunner(recordingSpawn([VERSION_OK, { exitCode: 1, stdout: failedRun }, { stdout: '[]' }])).run(PROMPT))
  expect(failed.errorClass).toBe('tool_attempt')
})

test('a cleanup failure never hides the run error or fails a good run, and logs the class only', async () => {
  const lines: string[] = []
  const good = await coreRunner(recordingSpawn([VERSION_OK, { stdout: OK_RUN }, { exitCode: 1, stdout: SECRET }]), (line) => lines.push(line)).run(PROMPT)
  expect(good.text).toBe('{"observations":[]}')
  expect(lines).toEqual(['opencode-cli cleanup failed: exit_nonzero'])
  const errorRun = ndjson(STEP_START, { type: 'error', sessionID: 'ses_1', error: { message: SECRET } })
  const bad = await caughtAsync(() => coreRunner(recordingSpawn([VERSION_OK, { exitCode: 1, stdout: errorRun }, { stdout: SECRET }]), (line) => lines.push(line)).run(PROMPT))
  expect(bad.errorClass).toBe('exit_nonzero')
  expect(lines).toEqual(['opencode-cli cleanup failed: exit_nonzero', 'opencode-cli cleanup failed: bad_response'])
  expect(lines.join('\n')).not.toContain(SECRET)
})

test('a system prompt holding {env: fails the run as internal before opencode run is spawned', async () => {
  const spawn = recordingSpawn([VERSION_OK])
  const error = await caughtAsync(() => coreRunner(spawn).run({ ...PROMPT, system: 'x {env:ANTHROPIC_API_KEY}' }))
  expect(error.errorClass).toBe('internal')
  expect(spawn.requests).toHaveLength(1)
})

test('an opencode older than 2.0.0 is refused before any run', async () => {
  const spawn = recordingSpawn([{ stdout: '1.14.2\n' }])
  const error = await caughtAsync(() => coreRunner(spawn).run(PROMPT))
  expect(error.errorClass).toBe('config_invalid')
  expect(spawn.requests).toHaveLength(1)
})

test('listModels through the core runs isolated', async () => {
  const spawn = recordingSpawn([VERSION_OK, { stdout: 'anthropic/claude-x\n' }])
  expect(await coreRunner(spawn).listModels()).toEqual(['anthropic/claude-x'])
  const request = spawn.requests[1]!
  expect(request.env.OPENCODE_CONFIG_DIR).toBe(join(request.cwd, 'config'))
  expect(request.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
  expect(JSON.parse(request.env.OPENCODE_CONFIG_CONTENT!).policies).toHaveLength(2)
})

// --- createCliRunner / createRunner ------------------------------------

const NO_CREDENTIALS: CredentialProvider = { get: () => null }

function settings(provider: ObserverSettings['provider']): ObserverSettings {
  return { provider, model: 'anthropic/claude-x', credentialRef: null, enabled: true, source: 'built-in' }
}

function fakeOpencodeOnPath(): string {
  const bin = join(temp.dataDir, 'fake-bin')
  mkdirSync(bin, { recursive: true })
  const path = join(bin, 'opencode')
  writeFileSync(path, '#!/bin/sh\nexit 99\n')
  chmodSync(path, 0o755)
  return bin
}

test('createCliRunner and createRunner build the opencode-cli runner', async () => {
  for (const build of [createCliRunner, createRunner]) {
    const spawn = recordingSpawn([VERSION_OK, { stdout: OK_RUN }, {}])
    const runner = build(settings('opencode-cli'), { dataDir: temp.dataDir, credentials: NO_CREDENTIALS, spawn, parentEnv: { PATH: fakeOpencodeOnPath(), XDG_DATA_HOME: '/d' } })
    expect((await runner.run(PROMPT)).text).toBe('{"observations":[]}')
    expect(spawn.requests[1]!.cmd.slice(1, 3)).toEqual(['run', '--standalone'])
    expect(spawn.requests[1]!.env.XDG_DATA_HOME).toBe('/d')
  }
})
