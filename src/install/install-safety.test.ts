import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { ObserverError, type ObserverRunner } from '../observer/types'
import { samHookGroup } from './claude-hooks'
import { installPaths } from './env'
import { EXIT_BLOCKED, EXIT_OK, install } from './install'
import { LAUNCHCTL } from './launch-agent'
import { BUN, type FakeWorld, YES, createWorld, snapshotTree } from './test-support'

const KEY = 'sk-or-v1-TESTONLY0123456789abcdefFAKE'
let world: FakeWorld | null = null
let foreign: RunningDaemon | null = null
afterEach(async () => {
  await foreign?.stop()
  foreign = null
  await world?.cleanup()
  world = null
})

function make(options: Parameters<typeof createWorld>[0] = {}): FakeWorld {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4', ...options })
  return world
}

const ok: ObserverRunner = { run: async () => ({ text: 'OK', model: 'x' }) }
const failing = (errorClass: 'credential_missing' | 'exit_nonzero'): ObserverRunner => ({
  run: async () => {
    throw new ObserverError(errorClass, 'test failure')
  },
})

function startForeign(w: FakeWorld): RunningDaemon {
  foreign = startDaemon({ dataDir: w.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  w.allowedPorts.add(foreign.port)
  return foreign
}

test('an already-running daemon is reported by pid and nothing is started or written', async () => {
  const w = make({ keychainRefs: ['openrouter'] })
  startForeign(w)
  expect(await install(w.env, YES)).toBe(EXIT_BLOCKED)
  expect(w.out.join('\n')).toContain(`(pid ${process.pid} from daemon.json); kinfold will not start a second one.`)
  expect(w.out.join('\n')).toContain(`stop it yourself (kill ${process.pid})`)
  expect(w.commands.filter((c) => c.argv[0] === LAUNCHCTL).map((c) => c.argv[1])).toEqual(['print'])
  expect(existsSync(installPaths(w.env).claudeSettings)).toBe(false)
  expect(existsSync(installPaths(w.env).launchAgentPlist)).toBe(false)
  expect(w.fetches).toEqual(['GET /health'])
})

test('--takeover waits for the user to stop the running daemon, never kills it, then bootstraps', async () => {
  const w = make({ keychainRefs: ['openrouter'] })
  const running = startForeign(w)
  let polls = 0
  w.env.sleep = async () => {
    polls += 1
    if (polls === 2) await running.stop()
  }
  expect(await install(w.env, { ...YES, takeover: true })).toBe(EXIT_OK)
  expect(w.out.join('\n')).toContain(`waiting for you to stop the running daemon: kill ${process.pid}`)
  expect(w.commands.filter((c) => c.argv[0] === LAUNCHCTL).map((c) => c.argv[1])).toEqual(['print', 'bootstrap'])
})

test('a missing key read from --credential-stdin goes to security -i on stdin only, never argv, env or output', async () => {
  let seen: string | null = null
  const w = make({ stdin: `${KEY}\n` })
  w.env.runnerFor = (settings, credentials) => {
    if (settings.provider === 'openrouter') seen = credentials.get('openrouter')
    return ok
  }
  expect(await install(w.env, { ...YES, credentialStdin: true })).toBe(EXIT_OK)
  expect(seen === KEY).toBe(true)
  const writes = w.securityCalls.filter((call) => call.args[0] === '-i' && call.stdin?.includes(' -a openrouter ') === true)
  expect(writes).toEqual([{ args: ['-i'], stdin: `add-generic-password -U -s kinfold -a openrouter -w ${KEY}\n` }])
  const snapshot = JSON.stringify({ commands: w.commands, security: w.securityCalls.map((call) => call.args), out: w.out, fetches: w.fetches })
  expect(snapshot).not.toContain(KEY)
  expect(w.out.some((line) => line.includes('-a openrouter -w <hidden>'))).toBe(true)
  expect(w.keychain.has('openrouter')).toBe(true)
})

test('dry run changes nothing in the temp home: same tree, modes and mtimes; only GET /health goes out', async () => {
  const w = make()
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, JSON.stringify({ theme: 'dark' }))
  mkdirSync(w.dataDir, { recursive: true, mode: 0o755 })
  writeFileSync(join(w.dataDir, 'memory.db'), '', { mode: 0o644 })
  const before = snapshotTree(w.home)
  expect(await install(w.env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  expect(w.fetches).toEqual(['GET /health'])
  expect(w.commands.filter((c) => c.argv[0] === LAUNCHCTL).map((c) => c.argv[1])).toEqual(['print'])
  expect(w.securityCalls.every((call) => call.args[0] === 'find-generic-password' && !call.args.includes('-w'))).toBe(true)
  expect(w.checks).toEqual([])
  const plan = w.out.join('\n')
  for (const part of ['plan (dry run, nothing is changed)', `write ${paths.claudeSettings}: add Kinfold hooks for SessionStart`, '/bin/launchctl bootstrap gui/501', 'PUT /observer/settings host=opencode provider=openrouter', 'would ask for it (no echo)']) {
    expect(plan).toContain(part)
  }
})

test('project-level Kinfold wiring in the current directory is reported and left untouched', async () => {
  const w = make({ keychainRefs: ['openrouter'] })
  mkdirSync(join(w.cwd, '.claude'), { recursive: true })
  const local = JSON.stringify({ hooks: { Stop: [samHookGroup('Stop', { bunPath: BUN, hookScript: '/x/src/cli/hook.ts' })] } })
  writeFileSync(join(w.cwd, '.claude', 'settings.local.json'), local)
  mkdirSync(join(w.cwd, '.opencode', 'plugins'), { recursive: true })
  writeFileSync(join(w.cwd, '.opencode', 'plugins', 'shared-agent-memory.js'), 'export { default } from "../../src/plugins/opencode.ts";\n')
  const before = snapshotTree(w.cwd)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const out = w.out.join('\n')
  expect(out).toContain('events would be captured twice')
  expect(out).toContain(join(w.cwd, '.claude', 'settings.local.json'))
  expect(out).toContain(join(w.cwd, '.opencode', 'plugins', 'shared-agent-memory.js'))
  expect(snapshotTree(w.cwd)).toEqual(before)
})

test('a failed check under --yes exits non-zero, names the error class, and writes nothing', async () => {
  const w = make({ keychainRefs: ['openrouter'], runner: (settings) => (settings.provider === 'openrouter' ? failing('credential_missing') : ok) })
  expect(await install(w.env, YES)).toBe(1)
  expect(w.out).toContain('observer check for opencode (openrouter/openrouter/auto) failed: credential_missing')
  expect(w.out.at(-1)).toBe('install failed: observer check for opencode failed: credential_missing')
  expect(existsSync(installPaths(w.env).claudeSettings)).toBe(false)
  expect(w.commands.some((c) => c.argv[1] === 'bootstrap')).toBe(false)
})

test('interactively, a failed check says so and asks again; no other provider is tried on its own', async () => {
  let calls = 0
  const w = make({ interactive: true, answers: ['', 'not-a-choice', 'claude-cli:sonnet', ''], keychainRefs: ['openrouter'] })
  w.env.runnerFor = (settings) => {
    w.checks.push(settings)
    calls += 1
    return calls === 1 ? failing('exit_nonzero') : ok
  }
  expect(await install(w.env, { ...YES, yes: false })).toBe(EXIT_OK)
  expect(w.checks.map((s) => `${s.provider}/${s.model}`)).toEqual(['claude-cli/haiku', 'claude-cli/sonnet', 'openrouter/openrouter/auto'])
  expect(w.out).toContain('observer check for claude-code (claude-cli/haiku) failed: exit_nonzero')
})

test('off macOS a key cannot be stored, so the install refuses instead of falling back', async () => {
  const w = make({ platform: 'linux' })
  expect(await install(w.env, YES)).toBe(1)
  expect(w.out.at(-1)).toBe('install failed: openrouter needs a key, and storing keys needs the macOS Keychain; linux is not supported yet')
})

test('the settings PUT carries the daemon token; a token the daemon rejects fails the install with 401', async () => {
  const w = make({ keychainRefs: ['openrouter'], opencodeVersion: null })
  const realFetch = w.env.fetch
  const schemes: string[] = []
  w.env.fetch = async (url, init) => {
    if (init.method !== 'PUT') return realFetch(url, init)
    const headers = init.headers as Record<string, string>
    schemes.push(String(headers.authorization).slice(0, 7))
    return realFetch(url, { ...init, headers: { ...headers, authorization: 'Bearer wrong' } })
  }
  expect(await install(w.env, YES)).toBe(1)
  expect(schemes).toEqual(['Bearer '])
  expect(w.out.at(-1)).toContain('PUT /observer/settings for claude-code answered 401')
})
