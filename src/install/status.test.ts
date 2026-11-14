import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeSamHooks, samHookGroup } from './claude-hooks'
import { entryCommand, entryIdentity, installedProgramPath } from './entry'
import { installPaths } from './env'
import { CODEX_HOOK_SPEC, mergeHostHooks } from './host-hooks'
import { detectHosts } from './detect'
import { EXIT_OK, install, reportDetections } from './install'
import { claudeMcpEntry } from './mcp-config'
import { mcpPaths, mcpTarget } from './mcp-wiring'
import { VERSION } from '../version'
import { status } from './status'
import { writeUpdateState } from '../update/state'
import { BUN, type FakeWorld, YES, createWorld, profilesWithDocsAgent, snapshotTree } from './test-support'
import { posixOnly } from '../../test/platform-guards'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function make(options: Parameters<typeof createWorld>[0] = {}): FakeWorld {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4', keychainRefs: ['openrouter'], ...options })
  return world
}

test('before install: hosts detected but not wired, daemon down, nothing created', async () => {
  const w = make({ withLibrary: false })
  const before = snapshotTree(w.home)
  expect(await status(w.env)).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  const paths = installPaths(w.env)
  expect(w.out).toEqual([
    'hosts:',
    `  claude-code: detected 2.1.310 (Claude Code); wired: no (no settings.json) in ${paths.claudeSettings}; captures, context at start and on each prompt, search`,
    `  opencode: detected 2.1.4; wired: no in ${paths.opencodePlugin}; captures, search`,
    `  continue: not detected (no safe signal for an IDE extension; name it with --hosts continue); wired: MCP not written (YAML config); run \`kinfold install --hosts continue --dry-run\` to print the block to add; Continue has no hooks; search needs the MCP block added to ~/.continue/config.yaml by hand; built from the docs, not yet checked against a real run`,
    `  not found: codex, cursor, gemini-cli, qwen-code, factory-droid, devin, kilo-code, cline, copilot, antigravity, junie, kiro, amp, kimi-code, auggie, goose, crush, zed, warp`,
    `mcp server ${entryIdentity(w.env.mode, 'mcp', w.env.dataDir)}:`,
    `  claude-code: no in ${mcpPaths(w.env).claudeUserConfig}`,
    `  opencode: no in ${mcpPaths(w.env).opencodeConfig}`,
    'service (LaunchAgent): config missing; running: no',
    'daemon /health: down (nothing answers on 127.0.0.1:37811 (TypeError))',
    'semantic search: off (no pinned sqlite-vec build for darwin-test-arch)',
    'database: not created yet (keychain db-key missing)',
    'key store: keychain (not recorded yet; the next install records it)',
    'disk encryption: could not check (fdesetup exit 127)',
    'observer settings: unknown (daemon.json or daemon.token is missing; the daemon is not running)',
    'keychain openrouter: present',
    'hmac keys: none yet; keychain hmac-master missing, hmac-legacy missing',
    `  sub-keys in ${join(w.dataDir, 'hmac.d')}: none`,
    `data dir ${w.dataDir}: missing`,
    'update check: off',
    'duplicate wiring: none in this directory',
  ])
  expect(w.securityCalls.every((call) => !call.args.includes('-w'))).toBe(true)
})

posixOnly('file modes')('after install: wired, loaded, healthy, observers with their source, modes ok', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  w.out.length = 0
  await status(w.env)
  const out = w.out.join('\n')
  expect(out).toContain('claude-code: detected 2.1.310 (Claude Code); wired: yes')
  expect(out).toContain('opencode: detected 2.1.4; wired: yes')
  expect(out).toContain('service (LaunchAgent): config present; running: yes')
  expect(out).toMatch(/daemon \/health: up on 127\.0\.0\.1:\d+ version \S+ schema \d+ pid \d+, LaunchAgent/)
  expect(out).toContain(` version ${VERSION} schema `)
  expect(out).toContain('  claude-code: claude-cli/haiku; source host')
  expect(out).toContain('  opencode: openrouter/openrouter/auto key openrouter; source host')
  expect(out).toMatch(/data dir .*: modes ok/)
})

posixOnly('file modes')('stale paths, loose modes and duplicate project wiring are each reported', async () => {
  const w = make({ withLibrary: false })
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, JSON.stringify({ hooks: { Stop: [samHookGroup('Stop', { entry: { command: BUN, args: ['/old/src/cli/hook.ts'] } })] } }))
  mkdirSync(paths.opencodePluginsDir, { recursive: true })
  writeFileSync(paths.opencodePlugin, 'export { default } from "/old/src/plugins/opencode.ts";\n')
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(join(w.dataDir, 'memory.db'), '')
  chmodSync(join(w.dataDir, 'memory.db'), 0o644)
  chmodSync(w.dataDir, 0o700)
  mkdirSync(join(w.cwd, '.claude'))
  writeFileSync(join(w.cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [samHookGroup('Stop', { entry: { command: BUN, args: ['/x/src/cli/hook.ts'] } })] } }))
  await status(w.env)
  const out = w.out.join('\n')
  expect(out).toContain('claude-code: detected 2.1.310 (Claude Code); wired: stale')
  expect(out).toContain('opencode: detected 2.1.4; wired: stale path')
  expect(out).toContain('1 of 2 need fixing')
  expect(out).toContain('  memory.db 0644 -> 0600')
  expect(out).toContain(join(w.cwd, '.claude', 'settings.json'))
})

test('status probes no keychain ref for codex-cli and opencode-cli observers', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const realFetch = w.env.fetch
  const settings = (provider: string) => ({ provider, model: 'm', credentialRef: 'stale-ref', enabled: true, source: 'host' })
  w.env.fetch = async (url, init) => {
    if (new URL(url).pathname !== '/observer/settings') return realFetch(url, init)
    const effective = [{ host: 'codex', settings: settings('codex-cli') }, { host: 'opencode', settings: settings('opencode-cli') }]
    return new Response(JSON.stringify({ rows: [], effective }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  w.out.length = 0
  w.securityCalls.length = 0
  await status(w.env)
  const out = w.out.join('\n')
  expect(out).toContain('  codex: codex-cli/m; source host')
  expect(out).not.toContain('stale-ref')
  expect(out.match(/^keychain /gm)?.length).toBe(1)
  expect(out).toContain('keychain openrouter: present')
})

function programInstallWorld(): { w: FakeWorld; binPath: string; options: typeof YES & { programSource: string } } {
  // No opencode here: installing its plugin needs release-build assets.
  const w = make({ opencodeVersion: undefined, keychainRefs: [] })
  const binPath = installedProgramPath(w.dataDir, w.env.platform)
  w.env = { ...w.env, mode: { kind: 'program', binPath } }
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, 'kinfold program v1\n', { mode: 0o755 })
  return { w, binPath, options: { ...YES, programSource: source } }
}

posixOnly('file modes')('status reports modes ok after a program install', async () => {
  const { w, options } = programInstallWorld()
  expect(await install(w.env, options)).toBe(EXIT_OK)
  w.out.length = 0
  expect(await status(w.env)).toBe(EXIT_OK)
  const text = w.out.join('\n')
  expect(text).toContain('modes ok')
  expect(text).toContain('program 0755')
  expect(text).not.toContain('bin/kinfold 0755 -> 0600')
})

posixOnly('file modes')('status shows the program-form wiring', async () => {
  const { w, binPath, options } = programInstallWorld()
  expect(await install(w.env, options)).toBe(EXIT_OK)
  w.out.length = 0
  expect(await status(w.env)).toBe(EXIT_OK)
  const hosts = w.out.filter((line) => line.startsWith('  claude-code:') || line.startsWith('  opencode:'))
  expect(hosts.length).toBeGreaterThan(0)
  expect(w.out.join('\n')).toContain(binPath)
  expect(statSync(binPath).mode & 0o777).toBe(0o755)
})

test('checkout status sees a hook for another folder as stale', async () => {
  const w = make({ withLibrary: false, codexVersion: 'codex-cli 0.120.0' })
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  const claude = mergeSamHooks({}, { entry: entryCommand(w.env.mode, 'hook', '/a') }).settings
  writeFileSync(paths.claudeSettings, JSON.stringify(claude))
  mkdirSync(paths.codexDir, { recursive: true })
  const codex = mergeHostHooks(CODEX_HOOK_SPEC, {}, { entry: entryCommand(w.env.mode, 'hook', '/a', 'codex') }).settings
  writeFileSync(paths.codexHooks, JSON.stringify(codex))

  await status(w.env)
  const out = w.out.join('\n')
  expect(out).toContain('claude-code: detected 2.1.310 (Claude Code); wired: stale')
  expect(out).toContain(`wired: stale in ${paths.codexHooks}`)

  const same = mergeSamHooks({}, { entry: entryCommand(w.env.mode, 'hook', w.env.dataDir) }).settings
  writeFileSync(paths.claudeSettings, JSON.stringify(same))
  w.out.length = 0
  await status(w.env)
  expect(w.out.join('\n')).toContain('claude-code: detected 2.1.310 (Claude Code); wired: yes')
})

test('status shows the notice', async () => {
  const w = make({ withLibrary: false })
  mkdirSync(w.dataDir, { recursive: true })
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.2.0', checkedAt: 1_800_000_000_000, notified: {} })
  await status(w.env, '0.1.0')
  expect(w.out).toContain('update: Kinfold 0.2.0 is available. Run `kinfold update`.')
  w.out.length = 0
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.1.0', checkedAt: 1_800_000_000_000, notified: {} })
  await status(w.env, '0.1.0')
  expect(w.out).toContain('update: none known (last checked 2027-01-15T08:00:00.000Z)')
})

test('status names the service', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  w.out.length = 0
  expect(await status(w.env)).toBe(EXIT_OK)
  expect(w.out).toContain('service (LaunchAgent): config present; running: yes')
})

test('status shows the capability line, the docs note and each manual step for an agent', async () => {
  const w = make({ withLibrary: false })
  expect(await status(w.env, undefined, profilesWithDocsAgent())).toBe(EXIT_OK)
  const at = w.out.findIndex((line) => line.startsWith('  gemini-cli:'))
  expect(w.out[at]).toBe('  gemini-cli: detected; wired: no; captures, context at start, search; built from the docs, not yet checked against a real run')
  expect(w.out[at + 1]).toBe('    gemini-cli: enable hooks in settings')
})

test('a real agent that is detected but not wired shows its manual step under its line, and an absent one shows none', async () => {
  const w = make({ versionResults: { crush: { exitCode: 0, stdout: 'crush version v0.11.0\n' } } })
  expect(await status(w.env)).toBe(EXIT_OK)
  const at = w.out.findIndex((line) => line.startsWith('  crush: detected crush version v0.11.0; wired: MCP no in '))
  expect(at).toBeGreaterThan(-1)
  expect(w.out[at + 1]).toStartWith('    crush: Kinfold never edits crushrc. To record Crush sessions, add these lines to ')
  expect(w.out[at + 1]).toContain('hook add PostToolUse --name kinfold --command ')
  // Cline is neither here nor wired, so its steps stay out of status.
  expect(w.out.some((line) => line.startsWith('    cline:'))).toBe(false)
})

test('a machine with only Claude Code shows one not-found line in status and in install, and Continue keeps its own', async () => {
  const w = make({ opencodeVersion: null })
  expect(await status(w.env)).toBe(EXIT_OK)
  const notFound = w.out.filter((line) => /^ {2}not found: /.test(line))
  expect(notFound).toHaveLength(1)
  expect(notFound[0]).toContain('codex, cursor')
  expect(notFound[0]).not.toContain('continue')
  expect(w.out.filter((line) => line.includes('not detected ('))).toHaveLength(1)
  expect(w.out.some((line) => line.startsWith('  continue: not detected (no safe signal'))).toBe(true)
  expect(w.out.some((line) => line.startsWith('  claude-code: detected'))).toBe(true)

  w.out.length = 0
  expect(await install(w.env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  const hostLines = w.out.filter((line) => line.startsWith('host ') || line.startsWith('not found: '))
  expect(hostLines.filter((line) => line.startsWith('not found: '))).toHaveLength(1)
  expect(hostLines.filter((line) => line.includes('skip (not found'))).toHaveLength(0)
  expect(hostLines.some((line) => line.startsWith('host continue'))).toBe(true)
})

test('naming Continue with --hosts prints its YAML block at plan time, dry run included', async () => {
  const w = make()
  expect(await install(w.env, { ...YES, dryRun: true, hosts: ['continue'] })).toBe(EXIT_OK)
  const text = w.out.join('\n')
  expect(text).toContain('mcpServers:')
  expect(text).toContain('- name: kinfold')
  expect(text).toContain('config.yaml')
  expect(text).not.toContain('shown by `kinfold status`')
})

test("status tells how to get Continue's block, and Warp says what its shared entry needs", async () => {
  const w = make()
  expect(await status(w.env)).toBe(EXIT_OK)
  expect(w.out.find((line) => line.startsWith('  continue:'))).toContain('kinfold install --hosts continue --dry-run')
  mkdirSync(join(w.root, 'Applications', 'Warp.app', 'Contents'), { recursive: true })
  writeFileSync(mcpPaths(w.env).claudeUserConfig, JSON.stringify({ mcpServers: { kinfold: JSON.parse(JSON.stringify(claudeMcpEntry(mcpTarget(w.env)))) } }))
  w.out.length = 0
  expect(await status(w.env)).toBe(EXIT_OK)
  expect(w.out.find((line) => line.startsWith('  warp:'))).toContain("uses the Claude Code entry (needs 'Auto-spawn servers from third-party agents' on in Warp)")
})

test('--hosts claude-code lists the other agents as left out on one line', async () => {
  const w = make()
  expect(await install(w.env, { ...YES, dryRun: true, hosts: ['claude-code'] })).toBe(EXIT_OK)
  const lines = w.out.filter((line) => line.startsWith('left out by --hosts:'))
  expect(lines).toHaveLength(1)
  expect(lines[0]).toStartWith('left out by --hosts: opencode, codex, cursor,')
  expect(lines[0]).not.toContain('claude-code')
  expect(w.out.filter((line) => line.includes('left out by --hosts)'))).toHaveLength(0)
  expect(w.out.some((line) => line.startsWith('host claude-code'))).toBe(true)
})

test('status keeps an agent with an unusable home override on its own line, outside the not-found line', async () => {
  const w = make()
  w.env = { ...w.env, copilotHomeEnv: join(w.root, 'nowhere') }
  expect(await status(w.env)).toBe(EXIT_OK)
  const own = w.out.find((line) => line.startsWith('  copilot: not detected'))
  expect(own).toContain('unknown (')
  expect(w.out.find((line) => line.startsWith('  not found: '))).not.toContain('copilot')
})

test('a wired agent whose binary is gone keeps its own line in install, and is not folded', async () => {
  let gone = false
  const w = make({ codexVersion: 'codex-cli 0.120.0', commandOverride: (argv) => (gone && argv[0] === 'codex' ? { exitCode: 127, stdout: '' } : undefined) })
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  gone = true
  w.out.length = 0
  // Not chosen, but its hooks are still in place: the stale wiring must show.
  reportDetections(w.env, await detectHosts(w.env, null), [])
  expect(w.out.some((line) => line.startsWith('host codex') && line.includes('not found'))).toBe(true)
  expect(w.out.find((line) => line.startsWith('not found: '))).not.toContain('codex')
})
