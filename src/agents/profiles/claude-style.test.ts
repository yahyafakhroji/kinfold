import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { runHook } from '../../cli/hook'
import type { ContextRequest } from '../../context/types'
import type { InstallEnv } from '../../install/env'
import { MCP_SERVER_NAME } from '../../install/mcp-config'
import { type FakeWorld, createWorld } from '../../install/test-support'
import { MCP_HOST_ENV } from '../../mcp/read-reporter'
import { cmdCommand, powershellCommand } from '../families/hook-shell'
import { type JsonAgentFile, jsonAgentFileInstallActions, jsonAgentFileUninstallActions } from '../families/json-agent'
import { hookTarget } from '../families/json-hooks'
import { assertWriterContract, fileWriter } from '../families/writer-contract.test-support'
import { hookSpecFor } from '../hook-specs'
import { profileOf } from '../install-profiles'
import { type AgentId, type AgentProfile, type Capabilities, capabilityLine } from '../profile'
import { COPILOT_FILES } from './copilot'
import { apply as applyActions } from './custom-hooks.test-support'
import { DEVIN_FILES } from './devin'
import { FACTORY_DROID_FILES } from './factory-droid'
import { JUNIE_FILES } from './junie'
import { QWEN_CODE_FILES } from './qwen-code'

const FIXTURES = join(import.meta.dir, '../../../test/fixtures')

let root: string
let dataDir: string
let asked: ContextRequest[]
let worlds: FakeWorld[] = []
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-claude-style-'))
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

/** Runs the hook on a fixture moved into the temp root, with a daemon that always has context to give. */
function hook(host: AgentId, file: string): Promise<string | null> {
  const raw = JSON.parse(readFileSync(join(FIXTURES, host, file), 'utf8')) as Record<string, unknown>
  const fetchFake = async (_url: string, init: RequestInit): Promise<Response> => {
    asked.push(JSON.parse(String(init.body)) as ContextRequest)
    return new Response(JSON.stringify({ text: '<kinfold>pack</kinfold>', observationIds: [], tokens: 5 }))
  }
  return runHook(JSON.stringify({ ...raw, session_id: raw.session_id ?? 'fixture-session', cwd: root }), dataDir, () => undefined, {}, { fetch: fetchFake, fallback: false }, host)
}

/** Every file of the agent meets the writer contract, from no file and from a file holding someone else's settings. */
function expectWriterContract(host: AgentId, files: readonly JsonAgentFile[]): void {
  for (const file of files) {
    const w = createWorld()
    worlds.push(w)
    const path = file.path(w.env)
    const { write, remove } = fileWriter(path, () => jsonAgentFileInstallActions(w.env, host, file), () => jsonAgentFileUninstallActions(w.env, host, file))
    // A Copilot hook file always has its version; ours adds one only when it is missing.
    const versioned = file.hooks?.version !== undefined ? { version: file.hooks.version } : {}
    const other = file.hooks?.hooksKey === null ? { Notification: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify' }] }] } : { ...versioned, theme: 'dark', mcpServers: { other: { command: 'npx' } } }
    assertWriterContract(write, remove, [null, `${JSON.stringify(other, null, 2)}\n`])
  }
}

function installedFile(host: AgentId, file: JsonAgentFile): { w: FakeWorld; json: Record<string, any> } {
  const w = createWorld()
  worlds.push(w)
  const actions = jsonAgentFileInstallActions(w.env, host, file)
  const write = actions.find((action) => action.kind === 'write')
  return { w, json: JSON.parse(write?.kind === 'write' ? write.content : '{}') }
}

/** A world whose agent home variable points at a folder in the temp root (or at `value` when given). */
function homeWorld(field: 'copilotHomeEnv' | 'junieHomeEnv', value?: string): { w: FakeWorld; dir: string } {
  const w = createWorld()
  worlds.push(w)
  const dir = join(w.root, 'agent-home')
  mkdirSync(dir)
  w.env = { ...w.env, [field]: value ?? dir } as InstallEnv
  return { w, dir: realpathSync(dir) }
}

async function expectHomeOverride(id: AgentId, field: 'copilotHomeEnv' | 'junieHomeEnv', variable: string): Promise<void> {
  const { w, dir } = homeWorld(field)
  const actions = await profile(id).wiring.install(w.env)
  const writes = actions.flatMap((action) => (action.kind === 'write' ? [action.path] : []))
  expect(writes.length).toBeGreaterThan(0)
  for (const path of writes) expect(path).toStartWith(`${dir}${sep}`)
  expect(w.out).toContain(`${id}: ${variable} is set; using ${dir}`)
  // The profile's own line: status folds an agent that is neither found nor wired into one line.
  const status = profile(id).wiring.line(w.env)
  expect(status).toContain(`in ${dir}${sep}`)

  const missing = homeWorld(field, 'nowhere')
  expect(await profile(id).wiring.install(missing.w.env)).toEqual([])
  expect(missing.w.out.at(-1)).toContain(`${id}: ${variable} points to "nowhere", but that path does not exist; nothing was wired. Fix or unset ${variable} and rerun`)
  expect(profile(id).wiring.state(missing.w.env)).toBe('unknown')
  expect(profile(id).wiring.line(missing.w.env)).toStartWith(`unknown (${variable} points to "nowhere"`)
}

const sessionLine = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
const promptLine = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })

describe('qwen-code', () => {
  test('qwen-code: the hook prints nothing on an event the agent can\'t take context for', async () => {
    for (const file of ['docs-constructed-post-tool-use.json', 'docs-constructed-stop.json', 'docs-constructed-session-end.json']) expect(await hook('qwen-code', file)).toBeNull()
    expect(asked).toEqual([])
    expect(await hook('qwen-code', 'docs-constructed-session-start.json')).toBe(sessionLine('<kinfold>pack</kinfold>'))
    expect(await hook('qwen-code', 'docs-constructed-user-prompt-submit.json')).toBe(promptLine('<kinfold>pack</kinfold>'))
  })

  test('qwen-code: install, re-run and uninstall meet the writer contract', () => {
    expectWriterContract('qwen-code', QWEN_CODE_FILES)
    const [settings] = QWEN_CODE_FILES
    if (settings === undefined) throw new Error('no settings file')
    const { w, json } = installedFile('qwen-code', settings)
    expect(settings.path(w.env)).toBe(join(w.env.homeDir, '.qwen', 'settings.json'))
    expect(Object.keys(json.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])
    expect(json.hooks.PostToolUse[0]).toMatchObject({ matcher: '*', hooks: [{ type: 'command', timeout: 10, async: true }] })
    expect(json.hooks.SessionStart[0].hooks[0].command).toContain('--host qwen-code')
    expect(json.mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'qwen-code' })
    expect(capabilityLine(profile('qwen-code'), 'macos')).toBe('captures, context at start and on each prompt, search')
  })
})

describe('factory-droid', () => {
  test('factory-droid: the hook prints nothing on an event the agent can\'t take context for', async () => {
    for (const file of ['docs-constructed-post-tool-use.json', 'docs-constructed-stop.json', 'docs-constructed-session-end.json']) expect(await hook('factory-droid', file)).toBeNull()
    expect(asked).toEqual([])
    expect(await hook('factory-droid', 'docs-constructed-session-start.json')).toBe(sessionLine('<kinfold>pack</kinfold>'))
    expect(await hook('factory-droid', 'docs-constructed-user-prompt-submit.json')).toBe(promptLine('<kinfold>pack</kinfold>'))
  })

  test('factory-droid: install, re-run and uninstall meet the writer contract', () => {
    expectWriterContract('factory-droid', FACTORY_DROID_FILES)
    const [hooks, mcp] = FACTORY_DROID_FILES
    if (hooks === undefined || mcp === undefined) throw new Error('two files expected')
    const { w, json } = installedFile('factory-droid', hooks)
    expect(hooks.path(w.env)).toBe(join(w.env.homeDir, '.factory', 'hooks.json'))
    // hooks.json is keyed by event name straight away, with no "hooks" wrapper.
    expect(Object.keys(json)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
    expect(json.PostToolUse[0]).toMatchObject({ matcher: '*', hooks: [{ type: 'command', timeout: 10 }] })
    const installed = installedFile('factory-droid', mcp)
    expect(mcp.path(installed.w.env)).toBe(join(installed.w.env.homeDir, '.factory', 'mcp.json'))
    expect(installed.json.mcpServers[MCP_SERVER_NAME]).toMatchObject({ type: 'stdio', env: { [MCP_HOST_ENV]: 'factory-droid' } })
  })
})

describe('devin', () => {
  test('devin: the hook prints nothing on an event the agent can\'t take context for', async () => {
    for (const file of ['docs-constructed-post-tool-use.json', 'docs-constructed-stop.json', 'docs-constructed-session-end.json']) expect(await hook('devin', file)).toBeNull()
    expect(asked).toEqual([])
    expect(await hook('devin', 'docs-constructed-session-start.json')).toBe(sessionLine('<kinfold>pack</kinfold>'))
  })

  test('devin: install, re-run and uninstall meet the writer contract', () => {
    expectWriterContract('devin', DEVIN_FILES)
    const [config, mcp] = DEVIN_FILES
    if (config === undefined || mcp === undefined) throw new Error('two files expected')
    const { w, json } = installedFile('devin', config)
    expect(config.path(w.env)).toBe(join(w.env.homeDir, '.config', 'devin', 'config.json'))
    expect(Object.keys(json.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
    // An omitted matcher matches every tool in Devin's docs.
    expect(json.hooks.PostToolUse[0]).toEqual({ hooks: [{ type: 'command', command: expect.stringContaining('--host devin'), timeout: 10 }] })
    const installed = installedFile('devin', mcp)
    expect(mcp.path(installed.w.env)).toBe(join(installed.w.env.homeDir, '.config', 'devin', 'mcp_config.json'))
    expect(installed.json.mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'devin' })
    const windows = createWorld({ platform: 'win32' })
    worlds.push(windows)
    expect(config.path(windows.env)).toBe(join(windows.env.homeDir, 'AppData', 'Roaming', 'devin', 'config.json'))
    expect(mcp.path(windows.env)).toBe(join(windows.env.homeDir, 'AppData', 'Roaming', 'devin', 'mcp_config.json'))
  })

  test('devin: captures with context at start and on each prompt, and names its Claude Code overlap', async () => {
    const devin = profile('devin')
    expect(devin.capabilities('macos')).toEqual({ capture: 'full', context: { sessionStart: true, prompt: true }, search: true, observer: false })
    expect(capabilityLine(devin, 'macos')).toStartWith('captures, context at start and on each prompt, search (Devin also runs Claude Code')
    expect(devin.alsoFiresFrom).toBe('claude-code')
    expect(devin.limit('macos')).toContain('only if it passes their args (Devin\'s docs list matcher, type, command and timeout only), unverified until a live run')
    const w = createWorld()
    worlds.push(w)
    expect(devin.manualSteps('macos', w.env)).toEqual([])
    expect(await hook('devin', 'docs-constructed-user-prompt-submit.json')).toBe(promptLine('<kinfold>pack</kinfold>'))
  })
})

describe('junie', () => {
  test('junie: the hook prints nothing on an event the agent can\'t take context for', async () => {
    expect(await hook('junie', 'docs-session-start.json')).toBeNull()
    expect(asked).toEqual([])
    expect(await hook('junie', 'docs-user-prompt-submit.json')).toBe(JSON.stringify({ additionalContext: '<kinfold>pack</kinfold>' }))
  })

  test('junie: install, re-run and uninstall meet the writer contract', () => {
    expectWriterContract('junie', JUNIE_FILES)
    const [config, mcp] = JUNIE_FILES
    if (config === undefined || mcp === undefined) throw new Error('two files expected')
    const { w, json } = installedFile('junie', config)
    expect(config.path(w.env)).toBe(join(w.env.homeDir, '.junie', 'config.json'))
    expect(Object.keys(json.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'])
    expect(json.hooks.Stop[0].hooks[0]).toMatchObject({ type: 'command', timeout: 10 })
    expect(mcp.path(w.env)).toBe(join(w.env.homeDir, '.junie', 'mcp', 'mcp.json'))
    expect(capabilityLine(profile('junie'), 'macos')).toStartWith('captures, context on each prompt, search (')
  })

  test('junie: JUNIE_HOME moves both files, and an unusable one skips Junie with the reason', () => expectHomeOverride('junie', 'junieHomeEnv', 'JUNIE_HOME'))

  test('junie: on Windows, the hooks are written for cmd, which Junie runs them through', async () => {
    const junie = profile('junie')
    expect(junie.capabilities('windows')).toEqual(junie.capabilities('macos'))
    expect(junie.limit('windows')).toBe(junie.limit('macos'))
    const w = createWorld({ platform: 'win32' })
    worlds.push(w)
    const writes = (await junie.wiring.install(w.env)).flatMap((action) => (action.kind === 'write' ? [action] : []))
    expect(writes.map((write) => write.path)).toEqual([join(w.env.homeDir, '.junie', 'config.json'), join(w.env.homeDir, '.junie', 'mcp', 'mcp.json')])
    const json = JSON.parse(writes[0]?.content ?? '{}')
    expect(json.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: cmdCommand(hookTarget(w.env, 'junie').entry), timeout: 10 })
    applyActions(await junie.wiring.install(w.env))
    expect(junie.wiring.state(w.env)).toBe('yes')
  })
})

describe('copilot', () => {
  test('copilot: the hook prints nothing on an event the agent can\'t take context for', async () => {
    expect(await hook('copilot', 'docs-constructed-user-prompt-submit.json')).toBeNull()
    expect(await hook('copilot', 'docs-constructed-post-tool-use.json')).toBeNull()
    expect(asked).toEqual([])
    expect(await hook('copilot', 'docs-constructed-session-start.json')).toBe(JSON.stringify({ additionalContext: '<kinfold>pack</kinfold>' }))
  })

  test('copilot: install, re-run and uninstall meet the writer contract', () => {
    expectWriterContract('copilot', COPILOT_FILES)
    const [hooks, mcp] = COPILOT_FILES
    if (hooks === undefined || mcp === undefined) throw new Error('two files expected')
    const { w, json } = installedFile('copilot', hooks)
    expect(hooks.path(w.env)).toBe(join(w.env.homeDir, '.copilot', 'hooks', 'kinfold.json'))
    expect(json.version).toBe(1)
    // PascalCase event names make Copilot send snake_case payloads with hook_event_name.
    expect(Object.keys(json.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'])
    expect(json.hooks.SessionStart[0]).toEqual({ command: expect.stringContaining('--host copilot'), timeout: 10 })
    const installed = installedFile('copilot', mcp)
    expect(mcp.path(installed.w.env)).toBe(join(installed.w.env.homeDir, '.copilot', 'mcp-config.json'))
    expect(installed.json.mcpServers[MCP_SERVER_NAME]).toMatchObject({ type: 'local', tools: ['*'], env: { [MCP_HOST_ENV]: 'copilot' } })
    expect(profile('copilot').alsoFiresFrom).toBeUndefined()
    expect(capabilityLine(profile('copilot'), 'macos')).toBe('captures, context at start, search')
  })

  test('copilot: uninstall deletes hooks/kinfold.json when nothing but its version is left, and keeps one holding anything else', async () => {
    const copilot = profile('copilot')
    const w = createWorld()
    worlds.push(w)
    const [hooks] = COPILOT_FILES
    if (hooks === undefined) throw new Error('no hooks file')
    const path = hooks.path(w.env)
    applyActions(await copilot.wiring.install(w.env))
    expect(existsSync(path)).toBe(true)
    const removal = copilot.wiring.uninstall(w.env)
    expect(removal.filter((action) => action.kind === 'remove').map((action) => (action.kind === 'remove' ? action.path : ''))).toEqual([path])
    applyActions(removal)
    expect(existsSync(path)).toBe(false)
    expect(copilot.wiring.uninstall(w.env).some((action) => action.kind === 'remove')).toBe(false)

    applyActions(await copilot.wiring.install(w.env))
    const theirs = { ...JSON.parse(readFileSync(path, 'utf8')), note: 'mine' }
    writeFileSync(path, JSON.stringify(theirs))
    applyActions(copilot.wiring.uninstall(w.env))
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, note: 'mine' })
  })

  test('copilot: COPILOT_HOME moves both files, and an unusable one skips Copilot with the reason', () => expectHomeOverride('copilot', 'copilotHomeEnv', 'COPILOT_HOME'))
})

describe('the five profiles', () => {
  test('are built from the docs, keyed by their id, with a hook spec, and never borrow a login for the observer', () => {
    for (const id of ['qwen-code', 'factory-droid', 'devin', 'junie', 'copilot'] as const) {
      expect(profile(id)).toMatchObject({ id, verification: 'docs', family: 'claude-style' })
      expect(profile(id).capabilities('macos').observer).toBe(false)
      expect(hookSpecFor(id)).not.toBeNull()
    }
  })
})

describe('on Windows', () => {
  test('copilot: the hooks are written for PowerShell, which Copilot runs them through', async () => {
    const copilot = profile('copilot')
    expect(copilot.capabilities('windows')).toEqual(copilot.capabilities('macos'))
    expect(copilot.limit('windows')).toBeNull()
    const w = createWorld({ platform: 'win32' })
    worlds.push(w)
    const writes = (await copilot.wiring.install(w.env)).flatMap((action) => (action.kind === 'write' ? [action] : []))
    expect(writes.map((write) => write.path)).toEqual([join(w.env.homeDir, '.copilot', 'hooks', 'kinfold.json'), join(w.env.homeDir, '.copilot', 'mcp-config.json')])
    const json = JSON.parse(writes[0]?.content ?? '{}')
    expect(json.hooks.Stop).toEqual([{ command: powershellCommand(hookTarget(w.env, 'copilot').entry), timeout: 10 }])
    applyActions(await copilot.wiring.install(w.env))
    expect(copilot.wiring.state(w.env)).toBe('yes')
  })

  test('qwen-code: the hooks are written for PowerShell and name it as their shell', async () => {
    const qwen = profile('qwen-code')
    expect(qwen.capabilities('windows')).toEqual(qwen.capabilities('macos'))
    expect(qwen.limit('windows')).toBeNull()
    const w = createWorld({ platform: 'win32' })
    worlds.push(w)
    const writes = (await qwen.wiring.install(w.env)).flatMap((action) => (action.kind === 'write' ? [action] : []))
    expect(writes.map((write) => write.path)).toEqual([join(w.env.homeDir, '.qwen', 'settings.json')])
    const json = JSON.parse(writes[0]?.content ?? '{}')
    expect(json.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: powershellCommand(hookTarget(w.env, 'qwen-code').entry), timeout: 10, shell: 'powershell' }] }])
    expect(json.mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: 'qwen-code' })
    // Off Windows Qwen Code picks bash itself, so the entry names no shell.
    const mac = createWorld()
    worlds.push(mac)
    const [macWrite] = (await qwen.wiring.install(mac.env)).flatMap((action) => (action.kind === 'write' ? [action] : []))
    expect(JSON.parse(macWrite?.content ?? '{}').hooks.Stop[0].hooks[0].shell).toBeUndefined()
  })

  // Neither agent's docs name the shell a hook runs through on Windows, so the POSIX command is not written there.
  const searchOnly: Capabilities = { capture: 'none', context: { sessionStart: false, prompt: false }, search: true, observer: false }
  const mcpPaths = (home: string): Record<'factory-droid' | 'devin', string> => ({
    'factory-droid': join(home, '.factory', 'mcp.json'),
    devin: join(home, 'AppData', 'Roaming', 'devin', 'mcp_config.json'),
  })

  for (const id of ['factory-droid', 'devin'] as const) {
    test(`${id}: on Windows, no hooks are planned, the MCP entry is, and the capability line says why`, async () => {
      const agent = profile(id)
      expect(agent.capabilities('windows')).toEqual(searchOnly)
      expect(capabilityLine(agent, 'windows')).toStartWith('search only (no hooks on Windows')
      expect(agent.limit('windows')).toContain('not yet checked')
      const w = createWorld({ platform: 'win32' })
      worlds.push(w)
      const writes = (await agent.wiring.install(w.env)).flatMap((action) => (action.kind === 'write' ? [action] : []))
      expect(writes.map((write) => write.path)).toEqual([mcpPaths(w.env.homeDir)[id]])
      const json = JSON.parse(writes[0]?.content ?? '{}')
      expect(json.hooks).toBeUndefined()
      expect(json.mcpServers[MCP_SERVER_NAME].env).toEqual({ [MCP_HOST_ENV]: id })
      // Off Windows the hooks are still written.
      expect(agent.capabilities('macos').capture).toBe('full')
    })
  }
})
