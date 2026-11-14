import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHook } from '../../cli/hook'
import type { ContextRequest } from '../../context/types'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import type { Action } from '../../install/plan'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { powershellCommand } from '../families/hook-shell'
import { type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { hookTarget } from '../families/json-hooks'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { profileOf } from '../install-profiles'
import { type AgentId, type AgentProfile, capabilityLine } from '../profile'
import { ANTIGRAVITY_FILES } from './antigravity'
import { GEMINI_CLI_FILES } from './gemini-cli'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures')

let root: string
let dataDir: string
let asked: ContextRequest[]
let worlds: FakeWorld[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-gemini-style-'))
  dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 4 }))
  writeFileSync(join(dataDir, 'daemon.token'), 'a'.repeat(64))
  asked = []
})
afterEach(async () => {
  rmSync(root, { recursive: true, force: true })
  for (const w of worlds) await w.cleanup()
  worlds = []
})

function profile(id: AgentId): AgentProfile {
  return profileOf(id)
}

function world(platform?: NodeJS.Platform): FakeWorld {
  const w = createWorld(platform !== undefined ? { platform } : {})
  worlds.push(w)
  return w
}

/** Runs the hook on a fixture moved into the temp root, with a daemon that always has context to give. */
function hook(host: AgentId, file: string, reshape: (raw: Record<string, unknown>) => Record<string, unknown> = (raw) => raw): Promise<string | null> {
  const raw = reshape(JSON.parse(readFileSync(join(FIXTURES, host, file), 'utf8')) as Record<string, unknown>)
  const moved = host === 'antigravity' ? { ...raw, workspacePaths: [root] } : { ...raw, cwd: root }
  const fetchFake = async (_url: string, init: RequestInit): Promise<Response> => {
    asked.push(JSON.parse(String(init.body)) as ContextRequest)
    return new Response(JSON.stringify({ text: '<kinfold>pack</kinfold>', observationIds: [], tokens: 5 }))
  }
  return runHook(JSON.stringify(moved), dataDir, () => undefined, {}, { fetch: fetchFake, fallback: false }, host)
}

function expectWriterContract(host: AgentId, files: readonly JsonAgentFile[]): void {
  for (const file of files) {
    const w = world()
    const path = file.path(w.env)
    const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, host, file), () => jsonAgentFileUninstallActions(w.env, host, file))
    const other = { theme: 'dark', mcpServers: { other: { command: 'npx' } }, 'my-linter': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './lint.sh', timeout: 10 }] }] } }
    assertWriterContract(write, remove, [null, `${JSON.stringify(other, null, 2)}\n`])
  }
}

function installedJson(host: AgentId, file: JsonAgentFile, w: FakeWorld = world()): Record<string, any> {
  const write = jsonAgentFileInstallActions(w.env, host, file).find((action) => action.kind === 'write')
  return JSON.parse(write?.kind === 'write' ? write.content : '{}')
}

const writesOf = (actions: readonly Action[]): string[] => actions.flatMap((action) => (action.kind === 'write' ? [action.path] : []))

/** Applies an install plan's file steps. */
function apply(actions: readonly Action[]): void {
  for (const action of actions) {
    if (action.kind === 'mkdir') mkdirSync(action.path, { recursive: true })
    if (action.kind === 'write') writeFileSync(action.path, action.content)
  }
}

describe('gemini-cli', () => {
  test('gemini-cli: the hook prints nothing on an event the agent can\'t take context for', async () => {
    for (const file of ['docs-constructed-after-tool.json', 'docs-constructed-after-agent.json', 'docs-constructed-session-end.json']) expect(await hook('gemini-cli', file)).toBeNull()
    expect(asked).toEqual([])
    expect(await hook('gemini-cli', 'docs-constructed-session-start.json')).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '<kinfold>pack</kinfold>' } }))
    expect(await hook('gemini-cli', 'docs-constructed-before-agent.json')).toBe(JSON.stringify({ hookSpecificOutput: { hookEventName: 'BeforeAgent', additionalContext: '<kinfold>pack</kinfold>' } }))
  })

  test('gemini-cli: install, re-run and uninstall meet the writer contract', () => {
    expectWriterContract('gemini-cli', GEMINI_CLI_FILES)
    const [settings] = GEMINI_CLI_FILES
    if (settings === undefined) throw new Error('no settings file')
    const w = world()
    const json = installedJson('gemini-cli', settings, w)
    expect(settings.path(w.env)).toBe(join(w.env.homeDir, '.gemini', 'settings.json'))
    expect(Object.keys(json.hooks)).toEqual(['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent', 'SessionEnd'])
    // Gemini counts hook timeouts in milliseconds; no matcher matches every tool.
    expect(json.hooks.AfterTool[0]).toEqual({ hooks: [{ type: 'command', command: expect.stringContaining('--host gemini-cli'), timeout: 10_000 }] })
    expect(json.mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'gemini-cli' })
    expect(capabilityLine(profile('gemini-cli'), 'macos')).toBe('captures, context at start and on each prompt, search')
  })

  test('gemini-cli: GEMINI_CLI_HOME moves the settings file, and an unusable one skips Gemini with the reason', async () => {
    const w = world()
    const dir = join(w.root, 'gemini-root')
    mkdirSync(dir)
    w.env = { ...w.env, geminiCliHomeEnv: dir }
    const real = realpathSync(dir)
    const actions = await profile('gemini-cli').wiring.install(w.env)
    expect(writesOf(actions)).toEqual([join(real, '.gemini', 'settings.json')])
    expect(w.out).toContain(`gemini-cli: GEMINI_CLI_HOME is set; using ${real}`)
    const status = profile('gemini-cli').wiring.line(w.env)
    expect(status).toContain(`in ${join(real, '.gemini', 'settings.json')}`)

    const missing = world()
    missing.env = { ...missing.env, geminiCliHomeEnv: 'nowhere' }
    expect(await profile('gemini-cli').wiring.install(missing.env)).toEqual([])
    expect(missing.out.at(-1)).toContain('gemini-cli: GEMINI_CLI_HOME points to "nowhere", but that path does not exist; nothing was wired. Fix or unset GEMINI_CLI_HOME and rerun')
    expect(profile('gemini-cli').wiring.state(missing.env)).toBe('unknown')
  })

  test('gemini-cli: on Windows, the hooks are written for PowerShell, which Gemini CLI runs them through', async () => {
    const gemini = profile('gemini-cli')
    expect(gemini.capabilities('windows')).toEqual(gemini.capabilities('macos'))
    expect(gemini.limit('windows')).toBeNull()
    const w = world('win32')
    const actions = await gemini.wiring.install(w.env)
    const write = actions.find((action) => action.kind === 'write')
    expect(writesOf(actions)).toEqual([join(w.env.homeDir, '.gemini', 'settings.json')])
    const json = JSON.parse(write?.kind === 'write' ? write.content : '{}')
    expect(json.hooks.SessionEnd).toEqual([{ hooks: [{ type: 'command', command: powershellCommand(hookTarget(w.env, 'gemini-cli').entry), timeout: 10_000 }] }])
    expect(json.mcpServers[MCP_SERVER_NAME]).toBeDefined()
  })
})

describe('antigravity', () => {
  const injected = JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: '<kinfold>pack</kinfold>' } }] })

  test('antigravity: the hook prints nothing on an event the agent can\'t take context for', async () => {
    // A prompt is still captured, but whether every prompt reaches us is unchecked, so none gets context.
    for (const file of ['docs-constructed-post-tool-use.json', 'docs-constructed-stop.json', 'docs-constructed-pre-invocation.json', 'docs-constructed-pre-invocation-later.json']) expect(await hook('antigravity', file)).toBeNull()
    expect(asked).toEqual([])
    expect(hookSpecFor('antigravity')?.promptContext).toBeUndefined()
    expect(await hook('antigravity', 'docs-session-start.json')).toBe(injected)
    expect(asked.map((request) => request.channel)).toEqual(['session_start'])
  })

  test('antigravity: a payload of no documented shape is not taken for a session start, and the hook stays silent', async () => {
    const unknown = (raw: Record<string, unknown>): Record<string, unknown> => ({ conversationId: raw.conversationId, workspacePaths: raw.workspacePaths, somethingNew: { at: 1 } })
    expect(await hook('antigravity', 'docs-session-start.json', unknown)).toBeNull()
    expect(await hook('antigravity', 'docs-session-start.json', (raw) => ({ ...raw, lastUserInput: 'hi' }))).toBeNull()
    expect(asked).toEqual([])
    expect(await hook('antigravity', 'docs-session-start.json')).toBe(injected)
    expect(asked.map((request) => request.channel)).toEqual(['session_start'])
  })

  test('antigravity: install, re-run and uninstall meet the writer contract', () => {
    expectWriterContract('antigravity', ANTIGRAVITY_FILES)
    const [hooks, mcp] = ANTIGRAVITY_FILES
    if (hooks === undefined || mcp === undefined) throw new Error('two files expected')
    const w = world()
    const json = installedJson('antigravity', hooks, w)
    expect(hooks.path(w.env)).toBe(join(w.env.homeDir, '.gemini', 'config', 'hooks.json'))
    // hooks.json maps a hook name to its events; tool events hold matcher groups, the rest hold handlers.
    expect(Object.keys(json)).toEqual(['kinfold'])
    expect(Object.keys(json.kinfold)).toEqual(['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop'])
    expect(json.kinfold.SessionStart).toEqual([{ type: 'command', command: expect.stringContaining('--host antigravity'), timeout: 10 }])
    expect(json.kinfold.PostToolUse).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: expect.stringContaining('--host antigravity'), timeout: 10 }] }])
    const installed = installedJson('antigravity', mcp)
    expect(mcp.path(w.env)).toBe(join(w.env.homeDir, '.gemini', 'config', 'mcp_config.json'))
    expect(installed.mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'antigravity' })
    expect(profile('antigravity').capabilities('macos').context).toEqual({ sessionStart: true, prompt: false })
    expect(capabilityLine(profile('antigravity'), 'macos')).toBe('captures, context at start, search (prompts after the first in a conversation may not be recorded until checked on a live run; Antigravity\'s hooks carry no tool output, so tool calls are recorded without it)')
  })

  test('antigravity: a hook named kinfold that is not ours is left alone, and a disabled one of ours stays disabled', () => {
    const [hooks] = ANTIGRAVITY_FILES
    if (hooks === undefined) throw new Error('no hooks file')
    const w = world()
    const path = hooks.path(w.env)
    mkdirSync(join(w.env.homeDir, '.gemini', 'config'), { recursive: true })
    writeFileSync(path, JSON.stringify({ kinfold: { Stop: [{ type: 'command', command: './mine.sh' }] } }))
    expect(jsonAgentFileInstallActions(w.env, 'antigravity', hooks)).toEqual([])
    expect(w.out.at(-1)).toContain('not ours')
    expect(jsonAgentFileUninstallActions(w.env, 'antigravity', hooks)).toEqual([])

    rmSync(path)
    apply(jsonAgentFileInstallActions(w.env, 'antigravity', hooks))
    const disabled = { kinfold: { ...JSON.parse(readFileSync(path, 'utf8')).kinfold, enabled: false } }
    writeFileSync(path, JSON.stringify(disabled))
    expect(jsonAgentFileInstallActions(w.env, 'antigravity', hooks)).toEqual([])
    expect(profile('antigravity').wiring.state(w.env)).toBe('yes')
  })

  test('antigravity: on Windows, no hooks are planned and the capability line says why', async () => {
    const antigravity = profile('antigravity')
    expect(antigravity.capabilities('windows')).toEqual({ capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false })
    expect(capabilityLine(antigravity, 'windows')).toStartWith('search only (no hooks on Windows')
    const w = world('win32')
    expect(writesOf(await antigravity.wiring.install(w.env))).toEqual([join(w.env.homeDir, '.gemini', 'config', 'mcp_config.json')])
  })
})

describe('the shared ~/.gemini folder', () => {
  test('Gemini and Antigravity installs never touch each other\'s file', async () => {
    const w = world()
    const gemini = profile('gemini-cli')
    const antigravity = profile('antigravity')
    const geminiPaths = [join(w.env.homeDir, '.gemini', 'settings.json')]
    const antigravityPaths = [join(w.env.homeDir, '.gemini', 'config', 'hooks.json'), join(w.env.homeDir, '.gemini', 'config', 'mcp_config.json')]

    const geminiInstall = await gemini.wiring.install(w.env)
    expect(writesOf(geminiInstall)).toEqual(geminiPaths)
    apply(geminiInstall)
    const geminiBytes = readFileSync(geminiPaths[0] ?? '', 'utf8')

    const antigravityInstall = await antigravity.wiring.install(w.env)
    expect(writesOf(antigravityInstall)).toEqual(antigravityPaths)
    apply(antigravityInstall)
    expect(readFileSync(geminiPaths[0] ?? '', 'utf8')).toBe(geminiBytes)
    expect(gemini.wiring.state(w.env)).toBe('yes')
    expect(antigravity.wiring.state(w.env)).toBe('yes')

    expect(writesOf(gemini.wiring.uninstall(w.env))).toEqual(geminiPaths)
    expect(writesOf(antigravity.wiring.uninstall(w.env))).toEqual(antigravityPaths)
  })
})

describe('the two profiles', () => {
  test('are built from the docs, keyed by their id, with a hook spec, and never borrow a login for the observer', () => {
    for (const id of ['gemini-cli', 'antigravity'] as const) {
      expect(profile(id)).toMatchObject({ id, verification: 'docs', family: 'gemini-style' })
      expect(profile(id).capabilities('macos').observer).toBe(false)
      expect(profile(id).manualSteps('macos', world().env)).toEqual([])
      expect(hookSpecFor(id)).not.toBeNull()
    }
    expect(profile('gemini-cli').detection).toMatchObject({ binaries: ['gemini'] })
    expect(profile('antigravity').detection).toMatchObject({ binaries: ['agy'] })
  })
})
