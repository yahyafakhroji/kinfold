import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EmbeddedAssets } from '../runtime/embedded'
import { DAEMON_INFO_FILE, DB_FILE } from '../store/data-dir'
import { samHookGroup } from './claude-hooks'
import { checkHealth, readDaemonInfo } from './daemon-client'
import { entryCommand, installedProgramPath, type InstallMode } from './entry'
import { installPaths } from './env'
import { CODEX_HOOK_SPEC, CURSOR_HOOK_SPEC, samItem } from './host-hooks'
import { EXIT_FAILED, EXIT_OK, install } from './install'
import { LAUNCHCTL } from './launch-agent'
import { MCP_SERVER_NAME, claudeMcpEntry, openCodeMcpEntry } from './mcp-config'
import { mcpPaths, mcpTarget } from './mcp-wiring'
import { pluginFileContent, shimContent } from './opencode-shim'
import { type FakeWorld, YES, createWorld, snapshotTree } from './test-support'

const CLAUDE = '2.1.310 (Claude Code)'
const OPENCODE = 'opencode v2.1.4'
const CODEX = 'codex-cli 0.120.0'
const CURSOR = '2.4.21'

const FOREIGN_CLAUDE_HOOK = { matcher: 'Startup', hooks: [{ type: 'command', command: '/usr/bin/other-hook' }] }
const FOREIGN_CLAUDE_MCP = { type: 'stdio', command: '/usr/bin/other-mcp', args: ['serve'] }
const FOREIGN_OPENCODE_MCP = { type: 'local', command: ['other-mcp'] }
const FOREIGN_CODEX_HOOK = { hooks: [{ type: 'command', command: '/usr/bin/other-codex', timeout: 5 }] }
const FOREIGN_CURSOR_HOOK = { command: "/bin/sh '/Users/dev/.other/cursor-hook.sh'", timeout: 10 }

const BUNDLE = [
  '// @bun',
  'var plugin_default = { id: "kinfold", setup() {} };',
  'export { plugin_default as default };',
  '',
].join('\n')

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function fakeAssets(bundle: string): EmbeddedAssets {
  return {
    sqlite3mc: { bytes: async () => new Uint8Array(), sha256: 'sqlite3mc-sha', sourceSha256: 'source-sha' },
    vec0: { bytes: async () => new Uint8Array(), sha256: 'vec0-sha' },
    dashboardFile: () => null,
    opencodePlugin: async () => bundle,
  }
}

function seedForeign(w: FakeWorld): void {
  const paths = installPaths(w.env)
  const mcp = mcpPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, `${JSON.stringify({ theme: 'dark', hooks: { SessionStart: [FOREIGN_CLAUDE_HOOK] } }, null, 2)}\n`)
  writeFileSync(join(w.home, '.claude.json'), `${JSON.stringify({ numStartups: 3, mcpServers: { 'other-tool': FOREIGN_CLAUDE_MCP } }, null, 2)}\n`)
  mkdirSync(mcp.opencodeDir, { recursive: true })
  writeFileSync(mcp.opencodeConfig, `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp: { 'other-tool': FOREIGN_OPENCODE_MCP } }, null, 2)}\n`)
  mkdirSync(paths.codexDir, { recursive: true })
  writeFileSync(paths.codexHooks, `${JSON.stringify({ hooks: { SessionStart: [FOREIGN_CODEX_HOOK] } }, null, 2)}\n`)
  mkdirSync(paths.cursorDir, { recursive: true })
  writeFileSync(paths.cursorHooks, `${JSON.stringify({ version: 1, hooks: { beforeSubmitPrompt: [FOREIGN_CURSOR_HOOK] } }, null, 2)}\n`)
}

/** A `claude` that behaves like the real CLI for the one thing the installer asks of it. */
function wireClaudeMcp(w: FakeWorld): void {
  const realRun = w.env.run
  w.env.run = async (request) => {
    const [binary, group, verb] = request.argv
    if (binary === 'claude' && group === 'mcp' && (verb === 'add-json' || verb === 'remove')) {
      const path = mcpPaths(w.env).claudeUserConfig
      const config = (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}) as Record<string, unknown> & { mcpServers?: Record<string, unknown> }
      const name = request.argv[5] ?? ''
      const servers = { ...(config.mcpServers ?? {}) }
      if (verb === 'add-json') servers[name] = JSON.parse(request.argv[6] ?? '{}')
      else delete servers[name]
      if (Object.keys(servers).length > 0) config.mcpServers = servers
      else delete config.mcpServers
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`)
    }
    return realRun(request)
  }
}

interface MoveWorld {
  w: FakeWorld
  source: string
  binPath: string
  program: InstallMode
  checkout: Extract<InstallMode, { kind: 'checkout' }>
}

/** A temp home already wired by a checkout install, with one foreign hook and MCP server in each host file. */
async function checkoutInstalled(): Promise<MoveWorld> {
  const w = createWorld({ claudeVersion: CLAUDE, opencodeVersion: OPENCODE, codexVersion: CODEX, cursorVersion: CURSOR, keychainRefs: ['openrouter'] })
  world = w
  seedForeign(w)
  wireClaudeMcp(w)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const checkout = w.env.mode as Extract<InstallMode, { kind: 'checkout' }>
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, 'kinfold program v1\n', { mode: 0o755 })
  const program: InstallMode = { kind: 'program', binPath: installedProgramPath(w.dataDir, w.env.platform) }
  return { w, source, binPath: program.binPath, program, checkout }
}

function useMode(move: MoveWorld, mode: InstallMode): void {
  move.w.env = { ...move.w.env, mode }
}

function programOptions(move: MoveWorld): Parameters<typeof install>[1] {
  return { ...YES, programSource: move.source, opencodeAssets: fakeAssets(BUNDLE) }
}

function backupNames(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((name) => name.includes('.kinfold-backup-')) : []
}

function clearBackups(dir: string): void {
  for (const name of backupNames(dir)) rmSync(join(dir, name))
}

function planLines(w: FakeWorld): string[] {
  return w.out.filter((line) => /^  \d+\. /.test(line))
}

function launchctlVerbs(w: FakeWorld): string[] {
  return w.commands.filter((call) => call.argv[0] === LAUNCHCTL).map((call) => call.argv[1] ?? '')
}

/** Keychain operations that change an entry, as opposed to the reads a daemon start makes. */
function keychainWrites(calls: FakeWorld['securityCalls'], from: number): FakeWorld['securityCalls'] {
  return calls.slice(from).filter((call) => call.args[0] === '-i' || call.args.includes('delete-generic-password') || call.args.includes('add-generic-password'))
}

test('a program install rewrites only Kinfold entries, keeps foreign ones and backs each changed config up', async () => {
  const move = await checkoutInstalled()
  const { w, program } = move
  const paths = installPaths(w.env)
  const config = mcpPaths(w.env)
  const checkoutTexts = {
    claude: readFileSync(paths.claudeSettings, 'utf8'),
    codex: readFileSync(paths.codexHooks, 'utf8'),
    cursor: readFileSync(paths.cursorHooks, 'utf8'),
    opencode: readFileSync(config.opencodeConfig, 'utf8'),
  }
  // The checkout install left its own backups; clear them so the move's backup is the one seen here.
  for (const dir of [paths.claudeDir, paths.codexDir, paths.cursorDir, config.opencodeDir]) clearBackups(dir)

  w.commands.length = 0
  useMode(move, program)
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)
  expect(w.commands.filter((call) => call.argv[0] === 'claude' && call.argv[1] === 'mcp').map((call) => call.argv[2])).toEqual(['remove', 'add-json'])

  const hookTarget = { entry: entryCommand(program, 'hook', w.dataDir) }
  // The host writers re-serialise each config as two-space JSON, so the
  // contract is the parsed content and key order, not the original bytes.
  const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf8')) as { theme: string; hooks: Record<string, unknown[]> }
  expect(Object.keys(settings)).toEqual(['theme', 'hooks'])
  expect(settings.theme).toBe('dark')
  expect(settings.hooks.SessionStart).toEqual([FOREIGN_CLAUDE_HOOK, samHookGroup('SessionStart', hookTarget)])
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'] as const) {
    expect(settings.hooks[event]).toEqual([samHookGroup(event, hookTarget)])
  }

  const codex = JSON.parse(readFileSync(paths.codexHooks, 'utf8')) as { hooks: Record<string, unknown[]> }
  expect(codex.hooks.SessionStart).toEqual([FOREIGN_CODEX_HOOK, samItem(CODEX_HOOK_SPEC, 'SessionStart', { entry: entryCommand(program, 'hook', w.dataDir, 'codex') })])
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'] as const) {
    expect(codex.hooks[event]).toEqual([samItem(CODEX_HOOK_SPEC, event, { entry: entryCommand(program, 'hook', w.dataDir, 'codex') })])
  }

  const cursor = JSON.parse(readFileSync(paths.cursorHooks, 'utf8')) as { version: number; hooks: Record<string, unknown[]> }
  expect(cursor.version).toBe(1)
  expect(cursor.hooks.beforeSubmitPrompt).toEqual([FOREIGN_CURSOR_HOOK, samItem(CURSOR_HOOK_SPEC, 'beforeSubmitPrompt', { entry: entryCommand(program, 'hook', w.dataDir, 'cursor') })])

  const opencode = JSON.parse(readFileSync(config.opencodeConfig, 'utf8')) as { $schema: string; mcp: Record<string, unknown> }
  expect(opencode.$schema).toBe('https://opencode.ai/config.json')
  expect(opencode.mcp['other-tool']).toEqual(FOREIGN_OPENCODE_MCP)
  expect(opencode.mcp[MCP_SERVER_NAME]).toEqual(openCodeMcpEntry(mcpTarget(w.env)))

  const claudeUser = JSON.parse(readFileSync(config.claudeUserConfig, 'utf8')) as { numStartups: number; mcpServers: Record<string, unknown> }
  expect(claudeUser.numStartups).toBe(3)
  expect(claudeUser.mcpServers['other-tool']).toEqual(FOREIGN_CLAUDE_MCP)
  expect(claudeUser.mcpServers[MCP_SERVER_NAME]).toEqual(claudeMcpEntry(mcpTarget(w.env)))

  const backups: [string, string][] = [
    [paths.claudeSettings, checkoutTexts.claude],
    [paths.codexHooks, checkoutTexts.codex],
    [paths.cursorHooks, checkoutTexts.cursor],
    [config.opencodeConfig, checkoutTexts.opencode],
  ]
  for (const [path, before] of backups) {
    const names = backupNames(dirname(path))
    expect(names).toHaveLength(1)
    expect(readFileSync(join(dirname(path), names[0]!), 'utf8')).toBe(before)
  }
  expect(readdirSync(w.home).filter((name) => name.startsWith('.claude.json.kinfold-backup-'))).toEqual([])
})

test('the OpenCode shim becomes the program-mode file', async () => {
  const move = await checkoutInstalled()
  const { w, program } = move
  const paths = installPaths(w.env)
  useMode(move, program)
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)

  const text = readFileSync(paths.opencodePlugin, 'utf8')
  expect(text).toBe(pluginFileContent(program, w.dataDir, BUNDLE))
  expect(text).toContain(`const KINFOLD_DATA_DIR = ${JSON.stringify(w.dataDir)};`)
})

test('the plist points at the program and the service restarts', async () => {
  const move = await checkoutInstalled()
  const { w, program } = move
  const paths = installPaths(w.env)
  useMode(move, program)
  w.commands.length = 0
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)

  const plist = readFileSync(paths.launchAgentPlist, 'utf8')
  expect(plist).toContain(`<key>ProgramArguments</key>\n  <array><string>${move.binPath}</string><string>--data-dir</string><string>${w.dataDir}</string><string>daemon</string></array>`)
  const verbs = launchctlVerbs(w)
  expect(verbs).toContain('bootout')
  expect(verbs.at(-1)).toBe('bootstrap')
  expect(w.launchd.loaded).toBe(true)
  expect((await checkHealth(w.env, readDaemonInfo(w.dataDir).port)).up).toBe(true)
})

test('the move plans no key, data folder or database action, and a real move applies none', async () => {
  const move = await checkoutInstalled()
  const { w, program } = move
  useMode(move, program)
  const securityCalls = w.securityCalls.length
  w.out.length = 0
  expect(await install(w.env, { ...programOptions(move), dryRun: true })).toBe(EXIT_OK)

  const lines = planLines(w)
  expect(lines.some((line) => line.includes(`install program ${move.binPath}`))).toBe(true)
  expect(lines.some((line) => line.includes(installPaths(w.env).claudeSettings))).toBe(true)
  for (const line of lines) {
    expect(line).not.toMatch(/keychain:/)
    expect(line).not.toMatch(/db-key/)
    expect(line).not.toMatch(/hmac-legacy|hmac-master/)
    expect(line).not.toMatch(/move .* -> /)
    expect(line).not.toMatch(/^  \d+\. chmod <dataDir>/)
    if (/^  \d+\. (mkdir|create|touch|write|remove|backup|chmod|move|link) /.test(line)) expect(line).not.toContain(w.dataDir)
  }
  expect(keychainWrites(w.securityCalls, securityCalls)).toEqual([])

  // The same checks against the applied plan, which is where a write would show.
  const dataBefore = snapshotTree(w.dataDir)
  const databaseInode = statSync(join(w.dataDir, DB_FILE)).ino
  const refsBefore = [...w.keychain].sort()
  w.out.length = 0
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)
  expect(keychainWrites(w.securityCalls, securityCalls)).toEqual([])
  expect([...w.keychain].sort()).toEqual(refsBefore)
  // A move that copies the program restarts the daemon, so daemon.json and the
  // store's WAL change with the new process. Every other file in the data dir
  // keeps its bytes and mode, none appears or disappears, and the store file
  // itself is the same file rather than a new one.
  const dataAfter = snapshotTree(w.dataDir)
  const runtime = new Set([DAEMON_INFO_FILE, DB_FILE, `${DB_FILE}-shm`, `${DB_FILE}-wal`])
  const outsideBin = Object.keys({ ...dataBefore, ...dataAfter }).filter((path) => path !== '.' && path !== 'bin' && !path.startsWith('bin/'))
  expect(outsideBin.filter((path) => dataAfter[path] === undefined)).toEqual([])
  for (const path of outsideBin) {
    expect(dataAfter[path]?.mode).toBe(dataBefore[path]?.mode)
    if (!runtime.has(path)) expect(dataAfter[path]).toEqual(dataBefore[path])
  }
  expect(statSync(join(w.dataDir, DB_FILE)).ino).toBe(databaseInode)
})

test('a checkout install afterwards moves the wiring back', async () => {
  const move = await checkoutInstalled()
  const { w, program, checkout } = move
  const paths = installPaths(w.env)
  const config = mcpPaths(w.env)
  useMode(move, program)
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)

  w.commands.length = 0
  useMode(move, checkout)
  w.out.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)

  const hookTarget = { entry: entryCommand(checkout, 'hook', w.dataDir) }
  expect(JSON.parse(readFileSync(paths.claudeSettings, 'utf8')).hooks.SessionStart).toEqual([FOREIGN_CLAUDE_HOOK, samHookGroup('SessionStart', hookTarget)])
  expect(JSON.parse(readFileSync(paths.codexHooks, 'utf8')).hooks.SessionStart).toEqual([FOREIGN_CODEX_HOOK, samItem(CODEX_HOOK_SPEC, 'SessionStart', { entry: entryCommand(checkout, 'hook', w.dataDir, 'codex') })])
  expect(JSON.parse(readFileSync(paths.cursorHooks, 'utf8')).hooks.beforeSubmitPrompt).toEqual([FOREIGN_CURSOR_HOOK, samItem(CURSOR_HOOK_SPEC, 'beforeSubmitPrompt', { entry: entryCommand(checkout, 'hook', w.dataDir, 'cursor') })])
  expect(readFileSync(paths.opencodePlugin, 'utf8')).toBe(shimContent(paths.pluginEntry, w.dataDir))
  expect(JSON.parse(readFileSync(config.opencodeConfig, 'utf8')).mcp[MCP_SERVER_NAME]).toEqual(openCodeMcpEntry(mcpTarget(w.env)))
  const claudeUser = JSON.parse(readFileSync(config.claudeUserConfig, 'utf8')) as { mcpServers: Record<string, unknown> }
  expect(claudeUser.mcpServers['other-tool']).toEqual(FOREIGN_CLAUDE_MCP)
  expect(claudeUser.mcpServers[MCP_SERVER_NAME]).toEqual(claudeMcpEntry(mcpTarget(w.env)))
  expect(readFileSync(paths.launchAgentPlist, 'utf8')).toContain(`<array><string>${checkout.bunPath}</string><string>${join(checkout.projectRoot, 'src', 'daemon', 'main.ts')}</string></array>`)
  expect(planLines(w).some((line) => line.includes('install program'))).toBe(false)
})

test('a second program install writes nothing but still checks the daemon', async () => {
  const move = await checkoutInstalled()
  const { w, program, checkout } = move
  useMode(move, program)
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)
  useMode(move, checkout)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  useMode(move, program)
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)

  w.out.length = 0
  w.commands.length = 0
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)
  const lines = planLines(w)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toContain('wait up to 180 s for GET /health (a large store takes a while to open)')
  expect(lines[0]).toEndWith('[done]')
  expect(w.out).not.toContain('plan: nothing to change')
  expect(launchctlVerbs(w)).toEqual(['print'])
})

test('an unchanged plist with a dead daemon restarts the service', async () => {
  const move = await checkoutInstalled()
  const { w, program } = move
  useMode(move, program)
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)
  const port = readDaemonInfo(w.dataDir).port
  await w.launchd.daemon?.stop()
  w.launchd.daemon = null
  expect((await checkHealth(w.env, port)).up).toBe(false)

  w.commands.length = 0
  expect(await install(w.env, programOptions(move))).toBe(EXIT_OK)
  expect(launchctlVerbs(w)).toEqual(['print', 'bootout', 'bootstrap'])
  expect(w.launchd.loaded).toBe(true)
  expect((await checkHealth(w.env, readDaemonInfo(w.dataDir).port)).up).toBe(true)
})

test('a failed step leaves the old wiring working', async () => {
  const move = await checkoutInstalled()
  const { w, program } = move
  const paths = installPaths(w.env)
  const config = mcpPaths(w.env)
  const oldPlugin = readFileSync(paths.opencodePlugin, 'utf8')
  const oldOpencode = readFileSync(config.opencodeConfig, 'utf8')
  useMode(move, program)
  // Make the plugin write fail before the temp file can be opened: a directory sits where the temp file would go.
  mkdirSync(join(paths.opencodePluginsDir, `.kinfold.js.kinfold-tmp-${process.pid}`))

  expect(await install(w.env, programOptions(move))).toBe(EXIT_FAILED)
  expect(w.out.some((line) => line.includes(paths.opencodePlugin) && line.endsWith('[failed]'))).toBe(true)
  expect(existsSync(move.binPath)).toBe(true)
  expect(readFileSync(paths.opencodePlugin, 'utf8')).toBe(oldPlugin)
  expect(readFileSync(config.opencodeConfig, 'utf8')).toBe(oldOpencode)
  expect(readFileSync(paths.claudeSettings, 'utf8')).toContain(JSON.stringify(entryCommand(program, 'hook', w.dataDir).command))
  expect(w.launchd.loaded).toBe(true)
  expect((await checkHealth(w.env, readDaemonInfo(w.dataDir).port)).up).toBe(true)
})
