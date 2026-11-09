import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { type TempStore, openTempStore } from '../test-support'
import { ObserverError, type ObserverPrompt } from '../types'
import { type SpawnFn, type SpawnRequest, spawnProcess } from './claude-cli'
import { type CliAdapter, type CliRunContext, RUNS_DIR, cliEnv, createCliObserverRunner } from './cli-core'
import { fakeCliAdapter, recordingSpawn } from './cli-test-support'
import { posixOnly } from '../../../test/platform-guards'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('kinfold-cli-core-')
})
afterEach(() => temp.cleanup())

const SECRET = 'SECRET-OUTPUT'
const PROMPT: ObserverPrompt = { system: 'SYSTEM RULES', user: 'EVENTS ON STDIN', eventIds: ['01JA'] }
const PARENT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/dev',
  USER: 'dev',
  LOGNAME: 'dev',
  TMPDIR: '/tmp/x',
  LANG: '',
  FAKE_CLI_HOME: '/Users/dev/.fake',
  OPENROUTER_API_KEY: 'sk-or-should-not-pass',
  ANTHROPIC_API_KEY: 'sk-ant-should-not-pass',
}
const VERSION_OK = { stdout: 'fakecli 1.2.3\n' }
const OK_OUTPUT = JSON.stringify({ text: '{"observations":[]}', model: 'fake/answered', session: 'ses_1' })

function runsRoot(): string {
  return join(temp.dataDir, 'observer', RUNS_DIR)
}

function runFolders(): string[] {
  return existsSync(runsRoot()) ? readdirSync(runsRoot()) : []
}

interface Harness {
  adapter: CliAdapter
  cleanups: CliRunContext[]
}

function harness(overrides: Partial<CliAdapter> = {}): Harness {
  const cleanups: CliRunContext[] = []
  const adapter = fakeCliAdapter({
    cleanup: async (ctx) => {
      cleanups.push(ctx)
    },
    ...overrides,
  })
  return { adapter, cleanups }
}

function runner(adapter: CliAdapter, spawn: SpawnFn, which: (command: string) => string | null = () => '/opt/bin/fakecli') {
  return createCliObserverRunner(adapter, { dataDir: temp.dataDir, model: 'fake/model', spawn, which, parentEnv: PARENT_ENV })
}

async function failure(promise: Promise<unknown>): Promise<ObserverError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof ObserverError) return error
    throw error
  }
  throw new Error('expected the run to fail')
}

// cliEnv

test('cliEnv keeps the base and extra keys, drops empty values, adds both observer flags, and never passes API keys', () => {
  expect(cliEnv(PARENT_ENV, ['FAKE_CLI_HOME', 'NOT_SET'])).toEqual({
    PATH: '/usr/bin:/bin',
    HOME: '/Users/dev',
    USER: 'dev',
    LOGNAME: 'dev',
    TMPDIR: '/tmp/x',
    FAKE_CLI_HOME: '/Users/dev/.fake',
    KINFOLD_OBSERVER: '1',
    SAM_OBSERVER: '1',
  })
  expect(cliEnv(PARENT_ENV, [])).not.toHaveProperty('OPENROUTER_API_KEY')
})

// run: the private run folder

posixOnly('file modes')('run spawns in a new 0700 folder under <dataDir>/observer/runs with the user text on stdin, then removes it', async () => {
  const { adapter, cleanups } = harness()
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])
  let seenMode = -1
  const watching: SpawnFn = async (request) => {
    if (request.cmd.includes('run')) seenMode = statSync(request.cwd).mode & 0o777
    return spawn(request)
  }
  const result = await runner(adapter, watching).run(PROMPT)

  expect(result).toEqual({ text: '{"observations":[]}', model: 'fake/answered' })
  const request = spawn.requests[1]!
  expect(request.cmd).toEqual(['/opt/bin/fakecli', 'run', '--model', 'fake/model'])
  expect(dirname(request.cwd)).toBe(runsRoot())
  expect(seenMode).toBe(0o700)
  expect(request.stdin).toBe('EVENTS ON STDIN')
  expect(request.env.KINFOLD_OBSERVER).toBe('1')
  expect(request.env).not.toHaveProperty('OPENROUTER_API_KEY')
  expect(existsSync(request.cwd)).toBe(false)
  expect(runFolders()).toEqual([])
  expect(cleanups).toHaveLength(1)
  expect(cleanups[0]!.sessionId).toBe('ses_1')
  expect(cleanups[0]!.runDir).toBe(request.cwd)
  expect(cleanups[0]!.title).toMatch(/^kinfold-observer-[0-9a-f]{16}$/)
})

test('each run gets its own folder and its own title', async () => {
  const titles: string[] = []
  const { adapter } = harness({
    invocation: ({ binaryPath, env, title }) => {
      titles.push(title)
      return { cmd: [binaryPath, 'run'], env, files: [] }
    },
  })
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }, VERSION_OK, { stdout: OK_OUTPUT }])
  const r = runner(adapter, spawn)
  await r.run(PROMPT)
  await r.run(PROMPT)
  expect(spawn.requests[1]!.cwd).not.toBe(spawn.requests[3]!.cwd)
  expect(titles[0]).not.toBe(titles[1])
})

test('the probe uses <binary> --version with a 5 s timeout and the child env', async () => {
  const { adapter } = harness()
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])
  await runner(adapter, spawn).run(PROMPT)
  const probe = spawn.requests[0]!
  expect(probe.cmd).toEqual(['/opt/bin/fakecli', '--version'])
  expect(probe.timeoutMs).toBe(5_000)
  expect(probe.stdin).toBe('')
  expect(probe.env).toEqual(cliEnv(PARENT_ENV, adapter.extraEnv))
})

// failures: classes, details and the finally paths

test('a parse error throws bad_response, removes the folder, and cleanup gets a null session id', async () => {
  const { adapter, cleanups } = harness()
  const spawn = recordingSpawn([VERSION_OK, { stdout: SECRET }])
  const error = await failure(runner(adapter, spawn).run(PROMPT))
  expect(error.errorClass).toBe('bad_response')
  expect(error.detail).not.toContain(SECRET)
  expect(runFolders()).toEqual([])
  expect(cleanups).toHaveLength(1)
  expect(cleanups[0]!.sessionId).toBeNull()
})

test('a parse that throws a plain Error becomes internal and keeps only the error name', async () => {
  const { adapter } = harness({
    parse: () => {
      throw new Error(SECRET)
    },
  })
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK, { stdout: SECRET }])).run(PROMPT))
  expect(error.errorClass).toBe('internal')
  expect(error.detail).not.toContain(SECRET)
  expect(error.message).not.toContain(SECRET)
  expect(runFolders()).toEqual([])
})

test('any tool event throws tool_attempt, still passes the parsed session id to cleanup, and removes the folder', async () => {
  const { adapter, cleanups } = harness()
  const stdout = JSON.stringify({ text: SECRET, tools: 1, session: 'ses_tool' })
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK, { stdout }])).run(PROMPT))
  expect(error.errorClass).toBe('tool_attempt')
  expect(error.detail).not.toContain(SECRET)
  expect(cleanups).toHaveLength(1)
  expect(cleanups[0]!.sessionId).toBe('ses_tool')
  expect(runFolders()).toEqual([])
})

test('exit code 3 throws exit_nonzero with detail "exited 3" and no stdout text', async () => {
  const { adapter, cleanups } = harness()
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK, { exitCode: 3, stdout: SECRET }])).run(PROMPT))
  expect(error.errorClass).toBe('exit_nonzero')
  expect(error.detail).toBe('exited 3')
  expect(cleanups).toHaveLength(1)
  expect(cleanups[0]!.sessionId).toBeNull()
  expect(runFolders()).toEqual([])
})

test('a timeout throws timeout with no stdout text, runs cleanup with a null session id, and removes the folder', async () => {
  const { adapter, cleanups } = harness()
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK, { timedOut: true, exitCode: 143, stdout: SECRET }])).run(PROMPT))
  expect(error.errorClass).toBe('timeout')
  expect(error.detail).not.toContain(SECRET)
  expect(cleanups).toHaveLength(1)
  expect(cleanups[0]!.sessionId).toBeNull()
  expect(runFolders()).toEqual([])
})

test('a spawn that cannot start throws, runs cleanup, and removes the folder', async () => {
  const { adapter, cleanups } = harness()
  let calls = 0
  const spawn: SpawnFn = async () => {
    calls += 1
    if (calls === 1) return { exitCode: 0, stdout: 'fakecli 1.2.3', timedOut: false }
    throw Object.assign(new Error(SECRET), { code: 'EACCES' })
  }
  const error = await failure(runner(adapter, spawn).run(PROMPT))
  expect(error.errorClass).toBe('internal')
  expect(error.detail).toContain('EACCES')
  expect(error.detail).not.toContain(SECRET)
  expect(cleanups).toHaveLength(1)
  expect(runFolders()).toEqual([])
})

test('a cleanup error never replaces the run error and never fails a good run', async () => {
  const throwing = harness({
    cleanup: async () => {
      throw new Error('cleanup broke')
    },
  })
  const ok = await runner(throwing.adapter, recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])).run(PROMPT)
  expect(ok.text).toBe('{"observations":[]}')
  const error = await failure(runner(throwing.adapter, recordingSpawn([VERSION_OK, { exitCode: 3 }])).run(PROMPT))
  expect(error.errorClass).toBe('exit_nonzero')
  expect(runFolders()).toEqual([])
})

test('cleanup runs before the run folder is removed', async () => {
  let folderExisted = false
  const { adapter } = harness({
    cleanup: async (ctx) => {
      folderExisted = existsSync(ctx.runDir)
    },
  })
  await runner(adapter, recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])).run(PROMPT)
  expect(folderExisted).toBe(true)
})

test('the configured model stands in when the CLI reports none', async () => {
  const { adapter } = harness()
  const result = await runner(adapter, recordingSpawn([VERSION_OK, { stdout: JSON.stringify({ text: 'x' }) }])).run(PROMPT)
  expect(result.model).toBe('fake/model')
})

test('cleanup receives exactly the env the spawned invocation used', async () => {
  const { adapter, cleanups } = harness({
    invocation: ({ binaryPath, env, runDir }) => ({ cmd: [binaryPath, 'run'], env: { ...env, RUN_MARKER: runDir }, files: [] }),
  })
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])
  await runner(adapter, spawn).run(PROMPT)
  expect(cleanups[0]!.env).toEqual(spawn.requests[1]!.env)
  expect(cleanups[0]!.env.RUN_MARKER).toBe(spawn.requests[1]!.cwd)
})

test('cleanup spawns through the core also carry the observer flags', async () => {
  const seen: Array<Record<string, string>> = []
  const { adapter } = harness({
    cleanup: async (ctx) => {
      await ctx.spawn({ cmd: ['x'], cwd: ctx.runDir, env: { PATH: '/bin' }, stdin: '', timeoutMs: 1 })
    },
  })
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }, {}])
  const watching: SpawnFn = async (request) => {
    seen.push({ ...request.env })
    return spawn(request)
  }
  await runner(adapter, watching).run(PROMPT)
  expect(seen[2]).toEqual({ PATH: '/bin', KINFOLD_OBSERVER: '1', SAM_OBSERVER: '1' })
})

test('the observer flags are merged into the spawn env even when the adapter drops them', async () => {
  const { adapter } = harness({
    invocation: ({ binaryPath }) => ({ cmd: [binaryPath, 'run'], env: { PATH: '/bin', KINFOLD_OBSERVER: '0' }, files: [] }),
  })
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])
  await runner(adapter, spawn).run(PROMPT)
  expect(spawn.requests[1]!.env).toEqual({ PATH: '/bin', KINFOLD_OBSERVER: '1', SAM_OBSERVER: '1' })
})

test('a cleanup failure logs one class-only line and leaves the run result and error unchanged', async () => {
  const lines: string[] = []
  const { adapter } = harness({
    cleanup: async () => {
      throw new Error(SECRET)
    },
  })
  const make = (spawn: SpawnFn) =>
    createCliObserverRunner(adapter, { dataDir: temp.dataDir, model: 'fake/model', spawn, which: () => '/opt/bin/fakecli', parentEnv: PARENT_ENV, log: (line) => lines.push(line) })
  const ok = await make(recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])).run(PROMPT)
  expect(ok).toEqual({ text: '{"observations":[]}', model: 'fake/answered' })
  const error = await failure(make(recordingSpawn([VERSION_OK, { exitCode: 3 }])).run(PROMPT))
  expect(error.errorClass).toBe('exit_nonzero')
  expect(lines).toEqual(['codex-cli cleanup failed: internal', 'codex-cli cleanup failed: internal'])
  expect(lines.join('\n')).not.toContain(SECRET)
  expect(runFolders()).toEqual([])
})

test('a logger that throws while reporting a cleanup failure still lets the run folder be removed and the result stand', async () => {
  const { adapter } = harness({
    cleanup: async () => {
      throw new Error(SECRET)
    },
  })
  const make = (spawn: SpawnFn) =>
    createCliObserverRunner(adapter, { dataDir: temp.dataDir, model: 'fake/model', spawn, which: () => '/opt/bin/fakecli', parentEnv: PARENT_ENV, log: () => { throw new Error('logger down') } })
  expect(await make(recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])).run(PROMPT)).toEqual({ text: '{"observations":[]}', model: 'fake/answered' })
  expect(runFolders()).toEqual([])
  expect((await failure(make(recordingSpawn([VERSION_OK, { exitCode: 3 }])).run(PROMPT))).errorClass).toBe('exit_nonzero')
  expect(runFolders()).toEqual([])
})

test('a non-zero exit whose output shows a tool event throws tool_attempt', async () => {
  const { adapter } = harness()
  const stdout = JSON.stringify({ text: SECRET, tools: 2 })
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK, { exitCode: 1, stdout }])).run(PROMPT))
  expect(error.errorClass).toBe('tool_attempt')
  expect(error.detail).not.toContain(SECRET)
})

test('a timeout whose output shows a tool event throws tool_attempt', async () => {
  const { adapter } = harness()
  const stdout = JSON.stringify({ text: SECRET, tools: 1 })
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK, { timedOut: true, exitCode: 143, stdout }])).run(PROMPT))
  expect(error.errorClass).toBe('tool_attempt')
  expect(error.detail).not.toContain(SECRET)
})

test('a non-zero exit with unparseable output stays exit_nonzero', async () => {
  const { adapter } = harness()
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK, { exitCode: 1, stdout: SECRET }])).run(PROMPT))
  expect(error.errorClass).toBe('exit_nonzero')
  expect(error.detail).toBe('exited 1')
})

// probe: version and binary

test('a version below minVersion makes probe and run throw config_invalid, with no folder and no main spawn', async () => {
  const { adapter, cleanups } = harness({ minVersion: [2, 0, 0] })
  const spawn = recordingSpawn([VERSION_OK, VERSION_OK])
  const r = runner(adapter, spawn)
  expect((await failure(r.probe())).errorClass).toBe('config_invalid')
  const error = await failure(r.run(PROMPT))
  expect(error.errorClass).toBe('config_invalid')
  expect(error.detail).toContain('2.0.0')
  expect(spawn.requests).toHaveLength(2)
  expect(cleanups).toHaveLength(0)
  expect(runFolders()).toEqual([])
})

test('versions compare by major, then minor, then patch', async () => {
  for (const [stdout, ok] of [['1.9.9', false], ['2.0.0', true], ['2.0.1', true], ['10.0.0', true], ['2.1.0', true]] as const) {
    const { adapter } = harness({ minVersion: [2, 0, 0] })
    const probe = runner(adapter, recordingSpawn([{ stdout }])).probe()
    if (ok) expect((await probe).version).toBe(stdout)
    else expect((await failure(probe)).errorClass).toBe('config_invalid')
  }
})

test('probe returns the parsed version and the resolved binary path', async () => {
  const { adapter } = harness()
  expect(await runner(adapter, recordingSpawn([{ stdout: 'fakecli v1.2.3 (build abc)' }])).probe()).toEqual({ version: '1.2.3', binaryPath: '/opt/bin/fakecli' })
})

test('unparseable --version output throws bad_response without quoting it', async () => {
  const { adapter } = harness()
  const error = await failure(runner(adapter, recordingSpawn([{ stdout: SECRET }])).probe())
  expect(error.errorClass).toBe('bad_response')
  expect(error.detail).not.toContain(SECRET)
})

test('a failing --version is reported by class without stdout', async () => {
  const { adapter } = harness()
  const exit = await failure(runner(adapter, recordingSpawn([{ exitCode: 2, stdout: SECRET }])).probe())
  expect(exit.errorClass).toBe('exit_nonzero')
  expect(exit.detail).toBe('exited 2')
  const slow = await failure(runner(adapter, recordingSpawn([{ timedOut: true, stdout: SECRET }])).probe())
  expect(slow.errorClass).toBe('timeout')
  expect(slow.detail).not.toContain(SECRET)
})

test('a missing binary throws cli_missing from probe, run and listModels', async () => {
  const { adapter, cleanups } = harness()
  const spawn = recordingSpawn([])
  const r = runner(adapter, spawn, () => null)
  expect((await failure(r.probe())).errorClass).toBe('cli_missing')
  expect((await failure(r.run(PROMPT))).errorClass).toBe('cli_missing')
  expect((await failure(r.listModels())).errorClass).toBe('cli_missing')
  expect(spawn.requests).toHaveLength(0)
  expect(cleanups).toHaveLength(0)
})

test('the binary is looked up by the adapter name on the child PATH', async () => {
  const { adapter } = harness()
  const lookups: Array<[string, string]> = []
  const which = (command: string, path: string): string | null => {
    lookups.push([command, path])
    return '/opt/bin/fakecli'
  }
  await createCliObserverRunner(adapter, { dataDir: temp.dataDir, model: 'm', spawn: recordingSpawn([VERSION_OK]), which, parentEnv: PARENT_ENV }).probe()
  expect(lookups).toEqual([['fakecli', '/usr/bin:/bin']])
})

test('an ENOENT from the probe spawn throws cli_missing', async () => {
  const { adapter } = harness()
  const spawn: SpawnFn = async () => {
    throw Object.assign(new Error('nope'), { code: 'ENOENT' })
  }
  expect((await failure(runner(adapter, spawn).probe())).errorClass).toBe('cli_missing')
})

test('an fs error in the probe maps by code to a class with no path in the detail', async () => {
  const { adapter } = harness()
  const fileAsDataDir = join(temp.root, 'not-a-dir')
  writeFileSync(fileAsDataDir, 'x')
  const r = createCliObserverRunner(adapter, { dataDir: fileAsDataDir, model: 'm', spawn: recordingSpawn([VERSION_OK]), which: () => '/opt/bin/fakecli', parentEnv: PARENT_ENV })
  const error = await failure(r.probe())
  expect(error.errorClass).toBe('internal')
  expect(error.detail).toMatch(/\((ENOTDIR|EEXIST)\)/)
  expect(error.message).not.toContain(temp.root)
})

test('a parseVersion that throws a plain Error maps to internal without its message', async () => {
  const { adapter } = harness({
    parseVersion: () => {
      throw new Error(SECRET)
    },
  })
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK])).probe())
  expect(error.errorClass).toBe('internal')
  expect(error.message).not.toContain(SECRET)
})

// runWithFiles and invocation files

test('runWithFiles writes each file into the run folder before spawn', async () => {
  const { adapter } = harness()
  const seen: Record<string, string> = {}
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])
  const watching: SpawnFn = async (request: SpawnRequest) => {
    if (request.cmd.includes('run')) {
      for (const name of readdirSync(request.cwd)) seen[name] = readFileSync(join(request.cwd, name), 'utf8')
    }
    return spawn(request)
  }
  await runner(adapter, watching).runWithFiles(PROMPT, [{ name: 'AGENTS.md', content: 'planted text' }])
  expect(seen).toEqual({ 'AGENTS.md': 'planted text' })
  expect(runFolders()).toEqual([])
})

test('invocation files are written into the run folder too', async () => {
  const { adapter } = harness({
    invocation: ({ binaryPath, env, system }) => ({ cmd: [binaryPath, 'run'], env, files: [{ name: 'instructions.md', content: system }] }),
  })
  let content = ''
  const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])
  const watching: SpawnFn = async (request) => {
    if (request.cmd.includes('run')) content = readFileSync(join(request.cwd, 'instructions.md'), 'utf8')
    return spawn(request)
  }
  await runner(adapter, watching).run(PROMPT)
  expect(content).toBe('SYSTEM RULES')
})

test('a file name that is not a plain name throws internal, spawns nothing, and leaves no folder', async () => {
  for (const name of ['../escape', 'a/b', 'a\\b', '..', '', 'x\0y', '.']) {
    const { adapter } = harness()
    const spawn = recordingSpawn([VERSION_OK, { stdout: OK_OUTPUT }])
    const error = await failure(runner(adapter, spawn).runWithFiles(PROMPT, [{ name, content: SECRET }]))
    expect(error.errorClass).toBe('internal')
    expect(error.detail).not.toContain(SECRET)
    expect(spawn.requests).toHaveLength(1)
    expect(runFolders()).toEqual([])
  }
})

test('an adapter invocation file with a bad name is rejected the same way', async () => {
  const { adapter } = harness({
    invocation: ({ binaryPath, env }) => ({ cmd: [binaryPath, 'run'], env, files: [{ name: '../x', content: 'c' }] }),
  })
  expect((await failure(runner(adapter, recordingSpawn([VERSION_OK])).run(PROMPT))).errorClass).toBe('internal')
  expect(runFolders()).toEqual([])
})

// listModels

test('listModels runs in its own run folder with the adapter isolated env, then removes the folder', async () => {
  let ctxSeen: { runDir: string; env: Record<string, string>; binaryPath: string } | null = null
  let existed = false
  const { adapter } = harness({
    isolatedEnv: (runDir, base) => ({ ...base, ISOLATED_DIR: runDir }),
    listModels: async (ctx) => {
      ctxSeen = ctx
      existed = existsSync(ctx.runDir)
      return ['a/b', 'c/d']
    },
  })
  expect(await runner(adapter, recordingSpawn([VERSION_OK])).listModels()).toEqual(['a/b', 'c/d'])
  expect(existed).toBe(true)
  expect(dirname(ctxSeen!.runDir)).toBe(runsRoot())
  expect(ctxSeen!.binaryPath).toBe('/opt/bin/fakecli')
  expect(ctxSeen!.env.ISOLATED_DIR).toBe(ctxSeen!.runDir)
  expect(ctxSeen!.env.KINFOLD_OBSERVER).toBe('1')
  expect(runFolders()).toEqual([])
})

test('a listModels failure keeps only its class and removes the folder', async () => {
  const { adapter } = harness({
    listModels: async () => {
      throw new Error(SECRET)
    },
  })
  const error = await failure(runner(adapter, recordingSpawn([VERSION_OK])).listModels())
  expect(error.errorClass).toBe('internal')
  expect(error.message).not.toContain(SECRET)
  expect(runFolders()).toEqual([])
})

// integration: a real process through spawnProcess

test('a real script gets the prompt on stdin, sees EOF, and only the allowed env names', async () => {
  const scriptDir = mkdtempSync(join(tmpdir(), 'kinfold-cli-script-'))
  try {
    const script = join(scriptDir, 'fakecli')
    writeFileSync(
      script,
      [
        '#!/bin/sh',
        'if [ "$1" = "--version" ]; then echo "fakecli 1.2.3"; exit 0; fi',
        'printf "STDIN:"',
        'cat',
        'printf "\\nENV:"',
        "env | sed 's/=.*//' | sort | tr '\\n' ','",
      ].join('\n'),
    )
    chmodSync(script, 0o700)
    const adapter = fakeCliAdapter({ parse: (stdout) => ({ text: stdout, model: null, toolEvents: 0, sessionId: null }) })
    const parentEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: scriptDir, KINFOLD_TEST_SECRET: 'nope' }
    const r = createCliObserverRunner(adapter, { dataDir: temp.dataDir, model: 'm', spawn: spawnProcess, which: () => script, parentEnv, timeoutMs: 10_000 })
    const result = await r.run({ system: 's', user: 'hello from stdin', eventIds: [] })
    expect(result.text).toContain('STDIN:hello from stdin\n')
    const names = result.text.split('ENV:')[1]!.split(',').filter((name) => name !== '')
    expect(names).toContain('KINFOLD_OBSERVER')
    expect(names).toContain('SAM_OBSERVER')
    expect(names).not.toContain('KINFOLD_TEST_SECRET')
    expect(runFolders()).toEqual([])
  } finally {
    rmSync(scriptDir, { recursive: true, force: true })
  }
})
