import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installPaths } from './env'
import { EXIT_OK, install } from './install'
import { LAUNCHCTL } from './launch-agent'
import { MCP_SERVER_NAME, claudeMcpEntry } from './mcp-config'
import { mcpPaths, mcpTarget } from './mcp-wiring'
import { pluginFileContent } from './opencode-shim'
import { type FakeWorld, YES, createWorld, snapshotTree } from './test-support'
import { uninstall } from './uninstall'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

const USER_SETTINGS = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }

async function installed(): Promise<FakeWorld> {
  const w = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4', keychainRefs: ['openrouter'] })
  world = w
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, `${JSON.stringify(USER_SETTINGS, null, 2)}\n`)
  mkdirSync(paths.opencodePluginsDir, { recursive: true })
  writeFileSync(join(paths.opencodePluginsDir, 'other-plugin.js'), 'export default {}\n')
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  w.commands.length = 0
  w.securityCalls.length = 0
  return w
}

test('uninstall removes only our hooks, the shim and the LaunchAgent; the data dir and keychain stay', async () => {
  const w = await installed()
  const paths = installPaths(w.env)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(JSON.parse(readFileSync(paths.claudeSettings, 'utf8'))).toEqual(USER_SETTINGS)
  expect(existsSync(paths.opencodePlugin)).toBe(false)
  expect(existsSync(join(paths.opencodePluginsDir, 'other-plugin.js'))).toBe(true)
  expect(existsSync(paths.launchAgentPlist)).toBe(false)
  expect(w.commands.filter((c) => c.argv[0] === LAUNCHCTL).map((c) => [...c.argv])).toEqual([
    [LAUNCHCTL, 'print', 'gui/501/dev.kinfold.daemon'],
    [LAUNCHCTL, 'bootout', 'gui/501/dev.kinfold.daemon'],
  ])
  expect(existsSync(w.dataDir)).toBe(true)
  expect(w.keychain.has('openrouter')).toBe(true)
  expect(w.out).toContain('kept keychain entry openrouter; remove it with: security delete-generic-password -s kinfold -a openrouter  (or rerun with --remove-credentials)')
  expect(w.out.some((line) => line.startsWith(`kept the data dir ${w.dataDir}`))).toBe(true)
})

test('uninstall removes a program-mode plugin file and leaves other plugins alone', async () => {
  const w = await installed()
  const paths = installPaths(w.env)
  const bundle = [
    '// @bun',
    'var plugin_default = { id: "kinfold", setup() {} };',
    'export { plugin_default as default };',
    '',
  ].join('\n')
  writeFileSync(paths.opencodePlugin, pluginFileContent({ kind: 'program', binPath: join(w.dataDir, 'bin', 'kinfold') }, w.dataDir, bundle))
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(existsSync(paths.opencodePlugin)).toBe(false)
  expect(existsSync(join(paths.opencodePluginsDir, 'other-plugin.js'))).toBe(true)
})

test('--remove-credentials deletes our keychain entries through delete-generic-password', async () => {
  const w = await installed()
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: true })).toBe(EXIT_OK)
  expect(w.keychain.has('openrouter')).toBe(false)
  expect(w.securityCalls.map((call) => call.args[0])).toContain('delete-generic-password')
})

test('uninstall --dry-run prints the plan and changes nothing', async () => {
  const w = await installed()
  const before = snapshotTree(w.home)
  w.fetches.length = 0
  expect(await uninstall(w.env, { dryRun: true, removeCredentials: true })).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  expect(w.launchd.loaded).toBe(true)
  expect(w.keychain.has('openrouter')).toBe(true)
  expect(w.fetches).toEqual([])
  const plan = w.out.join('\n')
  expect(plan).toContain('/bin/launchctl bootout gui/501/dev.kinfold.daemon')
  expect(plan).toContain(`remove ${installPaths(w.env).opencodePlugin}: the Kinfold OpenCode plugin file`)
  expect(plan).toContain('remove 6 Kinfold hook entries; every other key and hook kept')
  expect(plan).toContain('keychain: /usr/bin/security delete-generic-password -s kinfold -a openrouter')
})

test('a second uninstall has nothing to do, and a foreign file by our plugin name is left alone', async () => {
  const w = await installed()
  await uninstall(w.env, { dryRun: false, removeCredentials: false })
  writeFileSync(installPaths(w.env).opencodePlugin, 'export default { id: "someone-else" }\n')
  w.out.length = 0
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(w.out[0]).toContain('is not a Kinfold plugin file; left alone')
  expect(w.out).toContain('nothing to change')
  expect(existsSync(installPaths(w.env).opencodePlugin)).toBe(true)
})

test('the program and libraries are removed after the hosts are unwired, so a failed step leaves them in place', async () => {
  const w = createWorld({
    claudeVersion: '2.1.310 (Claude Code)',
    opencodeVersion: null,
    commandOverride: (argv) => (argv[1] === 'mcp' && argv[2] === 'remove' ? { exitCode: 1, stdout: '' } : undefined),
  })
  world = w
  const program = join(w.dataDir, 'bin', 'kinfold')
  mkdirSync(join(w.dataDir, 'bin'), { recursive: true })
  mkdirSync(join(w.dataDir, 'lib'), { recursive: true })
  writeFileSync(program, 'program')
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry(mcpTarget(w.env)) } }))

  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).not.toBe(EXIT_OK)

  expect(existsSync(program)).toBe(true)
  expect(existsSync(join(w.dataDir, 'lib'))).toBe(true)

  const dry = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: null })
  await world.cleanup()
  world = dry
  mkdirSync(join(dry.dataDir, 'bin'), { recursive: true })
  writeFileSync(mcpPaths(dry.env).claudeUserConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: claudeMcpEntry(mcpTarget(dry.env)) } }))
  expect(await uninstall(dry.env, { dryRun: true, removeCredentials: false })).toBe(EXIT_OK)
  const lines = dry.out.filter((line) => /^\s+\d+\. /.test(line))
  const mcp = lines.findIndex((line) => line.includes('claude mcp remove'))
  const bin = lines.findIndex((line) => line.includes('the installed kinfold program'))
  expect(mcp).toBeGreaterThanOrEqual(0)
  expect(bin).toBeGreaterThan(mcp)
})
