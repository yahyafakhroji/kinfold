import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { EXIT_OK, install } from './install'
import { MCP_SERVER_NAME, claudeMcpEntry, openCodeMcpEntry } from './mcp-config'
import { mcpPaths, mcpTarget } from './mcp-wiring'
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
  writeFileSync(paths.claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { type: 'stdio', command: target.bunPath, args: [target.serverScript] } } }))
  mkdirSync(paths.opencodeDir, { recursive: true })
  writeFileSync(paths.opencodeConfig, JSON.stringify({ mcp: { [MCP_SERVER_NAME]: { type: 'local', command: [target.bunPath, target.serverScript], enabled: true } } }))

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
  const old = { type: 'stdio', command: target.bunPath, args: [target.serverScript] }
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: old } }))

  expect(await install(w.env, YES)).not.toBe(EXIT_OK)

  expect(mcpCommands(w)).toEqual([
    ['claude', 'mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME],
    ['claude', 'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(claudeMcpEntry(target))],
    ['claude', 'mcp', 'add-json', '--scope', 'user', MCP_SERVER_NAME, JSON.stringify(old)],
  ])
  expect(w.out.some((line) => line.includes('the previous entry was put back'))).toBe(true)
})
