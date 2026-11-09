import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { EXIT_OK, install } from './install'
import { MCP_SERVER_NAME, claudeMcpEntry, openCodeMcpEntry } from './mcp-config'
import { claudeAddArgv, claudeMcpInstallActions, mcpPaths, mcpTarget, rollbackSafe } from './mcp-wiring'
import { type FakeWorld, YES, createWorld } from './test-support'
import { uninstall } from './uninstall'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const both = (): FakeWorld => {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: '2.1.4', keychainRefs: ['openrouter'] })
  return world
}

const mcpCommands = (w: FakeWorld): string[][] =>
  w.commands.map((request) => [...request.argv]).filter((argv) => argv[0] === 'claude' && argv[1] === 'mcp')

test('install registers through `claude mcp add-json` and merges the OpenCode entry, keeping foreign keys', async () => {
  const w = both()
  const paths = mcpPaths(w.env)
  mkdirSync(paths.opencodeDir, { recursive: true })
  writeFileSync(paths.opencodeConfig, JSON.stringify({ $schema: 'x', mcp: { other: { type: 'local', command: ['other'] } } }))

  expect(await install(w.env, YES)).toBe(EXIT_OK)

  expect(mcpCommands(w)).toEqual([['claude', 'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(claudeMcpEntry(mcpTarget(w.env)))]])
  const config = JSON.parse(readFileSync(paths.opencodeConfig, 'utf8'))
  expect(config.$schema).toBe('x')
  expect(config.mcp.other).toEqual({ type: 'local', command: ['other'] })
  expect(config.mcp[MCP_SERVER_NAME]).toEqual(openCodeMcpEntry(mcpTarget(w.env)))
})

test('an already registered Claude entry issues no command; uninstall removes both entries only', async () => {
  const w = both()
  const paths = mcpPaths(w.env)
  writeFileSync(paths.claudeUserConfig, JSON.stringify({ numStartups: 3, mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry(mcpTarget(w.env)) } }))
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(mcpCommands(w)).toEqual([])

  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(mcpCommands(w)).toEqual([['claude', 'mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]])
  expect(JSON.parse(readFileSync(paths.opencodeConfig, 'utf8')).mcp ?? {}).not.toHaveProperty(MCP_SERVER_NAME)
})

test('a foreign server under our name is left alone in both hosts', async () => {
  const w = both()
  const paths = mcpPaths(w.env)
  const foreign = { type: 'stdio', command: '/usr/bin/python3', args: ['other.py'] }
  writeFileSync(paths.claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: foreign } }))
  mkdirSync(paths.opencodeDir, { recursive: true })
  writeFileSync(paths.opencodeConfig, JSON.stringify({ mcp: { [MCP_SERVER_NAME]: { type: 'local', command: ['python3', 'other.py'] } } }))

  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(mcpCommands(w)).toEqual([])
  expect(JSON.parse(readFileSync(paths.opencodeConfig, 'utf8')).mcp[MCP_SERVER_NAME].command).toEqual(['python3', 'other.py'])
  expect(w.out.some((line) => line.includes('not ours'))).toBe(true)
})

test('re-running install replaces entries written before KINFOLD_MCP_HOST: remove then add for Claude, a rewrite for OpenCode', async () => {
  const w = both()
  const paths = mcpPaths(w.env)
  const target = mcpTarget(w.env)
  writeFileSync(paths.claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: target.entry.command, args: target.entry.args } } }))
  mkdirSync(paths.opencodeDir, { recursive: true })
  writeFileSync(paths.opencodeConfig, JSON.stringify({ mcp: { [MCP_SERVER_NAME]: { type: 'local', command: [target.entry.command, ...target.entry.args], enabled: true } } }))

  expect(await install(w.env, YES)).toBe(EXIT_OK)

  expect(mcpCommands(w)).toEqual([
    ['claude', 'mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME],
    ['claude', 'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(claudeMcpEntry(target))],
  ])
  expect(JSON.parse(readFileSync(paths.opencodeConfig, 'utf8')).mcp[MCP_SERVER_NAME]).toEqual(openCodeMcpEntry(target))
  expect(JSON.parse(mcpCommands(w)[1]!.at(-1)!).env).toEqual({ KINFOLD_MCP_HOST: 'claude-code' })
})

test('a failed Claude add puts the previous entry back and fails the step', async () => {
  let failedOnce = false
  world = createWorld({
    claudeVersion: '2.1.310 (Claude Code)',
    opencodeVersion: null,
    keychainRefs: ['openrouter'],
    commandOverride: (argv) => {
      if (argv[1] === 'mcp' && argv[2] === 'add-json' && !failedOnce) {
        failedOnce = true
        return { exitCode: 1, stdout: '' }
      }
      return undefined
    },
  })
  const w = world
  const target = mcpTarget(w.env)
  const old = { type: 'stdio', command: target.entry.command, args: target.entry.args }
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: old } }))

  expect(await install(w.env, YES)).not.toBe(EXIT_OK)

  expect(mcpCommands(w)).toEqual([
    ['claude', 'mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME],
    ['claude', 'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(claudeMcpEntry(target))],
    ['claude', 'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(old)],
  ])
  expect(w.out.some((line) => line.includes('the previous entry was put back'))).toBe(true)
})

test('the MCP swap never puts a hand-added env value into argv', async () => {
  const w = both()
  const target = mcpTarget(w.env)
  const previous = { type: 'stdio', command: target.entry.command, args: target.entry.args, env: { KINFOLD_MCP_HOST: 'claude-code', API_TOKEN: 's3cret' } }
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: previous } }))

  const actions = claudeMcpInstallActions(w.env)
  expect(actions.some((action) => action.kind === 'claude-mcp-replace')).toBe(false)
  expect(w.out.some((line) => line.includes('env values Kinfold did not write'))).toBe(true)
  expect(JSON.stringify(actions)).not.toContain('s3cret')
  expect(w.out.join('\n')).not.toContain('s3cret')

  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(mcpCommands(w)).toEqual([])
  expect(w.out.join('\n')).not.toContain('s3cret')
})

test('rollbackSafe accepts an absent env or one holding only the host name', () => {
  expect(rollbackSafe({ type: 'stdio' })).toBe(true)
  expect(rollbackSafe({ env: { KINFOLD_MCP_HOST: 'claude-code' } })).toBe(true)
  expect(rollbackSafe({ env: {} })).toBe(true)
  expect(rollbackSafe({ env: { KINFOLD_MCP_HOST: 'claude-code', A: 'b' } })).toBe(false)
  expect(rollbackSafe({ env: 'x' })).toBe(false)
})

test('a rollback replays only KINFOLD_MCP_HOST', async () => {
  let failedOnce = false
  world = createWorld({
    claudeVersion: '2.1.310 (Claude Code)',
    opencodeVersion: null,
    keychainRefs: ['openrouter'],
    commandOverride: (argv) => {
      if (argv[1] === 'mcp' && argv[2] === 'add-json' && !failedOnce) {
        failedOnce = true
        return { exitCode: 1, stdout: '' }
      }
      return undefined
    },
  })
  const w = world
  const target = mcpTarget(w.env)
  const previous = { type: 'stdio', command: target.entry.command, args: ['/old/src/mcp/server.ts'], env: { KINFOLD_MCP_HOST: 'claude-code' } }
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: previous } }))

  expect(await install(w.env, YES)).not.toBe(EXIT_OK)

  const putBack = mcpCommands(w).at(-1)!
  expect(putBack).toEqual(claudeAddArgv(previous))
  expect(JSON.parse(putBack.at(-1)!).env).toEqual({ KINFOLD_MCP_HOST: 'claude-code' })
})

test('a remove that times out does not claim the entry was kept', async () => {
  world = createWorld({
    claudeVersion: '2.1.310 (Claude Code)',
    opencodeVersion: null,
    keychainRefs: ['openrouter'],
    commandOverride: (argv) => (argv[1] === 'mcp' && argv[2] === 'remove' ? { exitCode: 124, stdout: '', timedOut: true } : undefined),
  })
  const w = world
  const target = mcpTarget(w.env)
  const previous = { type: 'stdio', command: target.entry.command, args: ['/old/src/mcp/server.ts'], env: { KINFOLD_MCP_HOST: 'claude-code' } }
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: previous } }))

  expect(await install(w.env, YES)).not.toBe(EXIT_OK)
  const text = w.out.join('\n')
  expect(text).toContain('claude mcp remove did not finish; check the entry with claude mcp list --scope user')
  expect(text).not.toContain('left in place')
})

test('unticking Claude Code after its CLI is gone skips the MCP remove with a note and finishes the install', async () => {
  let claudeGone = false
  world = createWorld({
    claudeVersion: '2.1.310 (Claude Code)',
    opencodeVersion: '2.1.4',
    keychainRefs: ['openrouter'],
    commandOverride: (argv) => (claudeGone && argv[0] === 'claude' ? { exitCode: 127, stdout: '' } : undefined),
  })
  const w = world
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  // The fake CLI does not write ~/.claude.json, so put the entry there as the real one would.
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry(mcpTarget(w.env)) } }))
  const before = readFileSync(mcpPaths(w.env).claudeUserConfig, 'utf8')
  claudeGone = true
  w.out.length = 0
  w.commands.length = 0

  expect(await install(w.env, { ...YES, hosts: ['opencode'] })).toBe(EXIT_OK)
  const text = w.out.join('\n')
  expect(text).toContain('claude not found: the Kinfold entry is still in Claude Code\'s config; remove it with claude mcp remove --scope user kinfold once Claude Code is back')
  expect(text).toContain('installed.')
  expect(mcpCommands(w)).toEqual([['claude', 'mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]])
  expect(readFileSync(mcpPaths(w.env).claudeUserConfig, 'utf8')).toBe(before)
})

test('a Claude Code MCP remove that fails for another reason still fails the step', async () => {
  let failing = false
  world = createWorld({
    claudeVersion: '2.1.310 (Claude Code)',
    opencodeVersion: '2.1.4',
    keychainRefs: ['openrouter'],
    commandOverride: (argv) => (failing && argv[0] === 'claude' && argv[2] === 'remove' ? { exitCode: 1, stdout: '' } : undefined),
  })
  const w = world
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry(mcpTarget(w.env)) } }))
  failing = true
  w.out.length = 0
  expect(await install(w.env, { ...YES, hosts: ['opencode'] })).not.toBe(EXIT_OK)
  expect(w.out.join('\n')).not.toContain('claude not found')
})
