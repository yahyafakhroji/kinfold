import { writeBackupRecord } from '../backup/record'
import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
import { fakeTerminal } from './prompt/fake-terminal'
import { runFramed } from './prompt/frame'
import { autoUpdateBlocker, status, statusMark } from './status'
import { mergeAutoState } from '../update/auto-state'
import { fakeService } from './test-support'
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
    'memory: local (this machine\'s own)',
    'database: not created yet (keychain db-key missing)',
    'key store: keychain (not recorded yet; the next install records it)',
    'disk encryption: could not check (fdesetup exit 127)',
    'observer settings: unknown (daemon.json or daemon.token is missing; the daemon is not running)',
    'keychain openrouter: present',
    'hmac keys: none yet; keychain hmac-master missing, hmac-legacy missing',
    `  sub-keys in ${join(w.dataDir, 'hmac.d')}: none`,
    `data dir ${w.dataDir}: missing`,
    'update check: off',
    'auto-update: off (no install record)',
    'kinfold command: not on PATH; a checkout has no installed program',
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

test('status says an observer is off, in the words the wizard used', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const realFetch = w.env.fetch
  w.env.fetch = async (url, init) => {
    if (new URL(url).pathname !== '/observer/settings') return realFetch(url, init)
    const effective = [
      { host: 'claude-code', settings: { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: false, source: 'host' } },
      { host: 'opencode', settings: { provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter', enabled: true, source: 'built-in' } },
    ]
    return new Response(JSON.stringify({ rows: [], effective }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  w.out.length = 0
  await status(w.env)
  expect(w.out).toContain('  claude-code: off (capture only); source host')
  expect(w.out.join('\n')).not.toContain('(disabled)')
  // An observer that is off needs no key, so status asks about none for it.
  expect(w.out).toContain('  opencode: openrouter/openrouter/auto key openrouter; source built-in')
})

test('status says which observer provider is backing off and what to check', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const realFetch = w.env.fetch
  const line = 'claude-cli has failed 1300 times since 2026-11-14 10:29: exit_nonzero; retrying at 2026-11-17 09:00; check `claude` works in a terminal'
  w.env.fetch = async (url, init) => {
    if (new URL(url).pathname !== '/observer/settings') return realFetch(url, init)
    const effective = [{ host: 'claude-code', settings: { provider: 'claude-cli', model: 'haiku', credentialRef: null, enabled: true, source: 'host' } }]
    const backoff = [{ provider: 'claude-cli', errorClass: 'exit_nonzero', failures: 1300, since: 1, retryAt: 2, line }]
    return new Response(JSON.stringify({ rows: [], effective, backoff }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  w.out.length = 0
  await status(w.env)
  expect(w.out).toContain(`  observer backing off: ${line}`)
})

test('status says when the recall line is off and when the impact test is on, and nothing about either otherwise', async () => {
  const w = make()
  mkdirSync(w.dataDir, { recursive: true })
  await status(w.env)
  expect(w.out.some((line) => line.startsWith('recall line:') || line.startsWith('impact test:'))).toBe(false)

  writeFileSync(join(w.dataDir, 'display.json'), JSON.stringify({ showRecall: false, holdout: true }))
  w.out.length = 0
  await status(w.env)
  expect(w.out).toContain('recall line: off; agents show nothing about what Kinfold recalled (turn it on with kinfold install --show-recall or in the dashboard)')
  expect(w.out).toContain('impact test: on for Claude Code; about 1 prompt in 10 goes without recalled memory, and says so (turn it off with kinfold install --no-holdout or in the dashboard)')
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

test('status says when the last backup was made, and nothing when there is none', async () => {
  const w = make({ withLibrary: false })
  mkdirSync(w.dataDir, { recursive: true })
  await status(w.env, '0.1.0')
  expect(w.out.some((line) => line.startsWith('backup:'))).toBe(false)
  w.out.length = 0
  writeBackupRecord(w.dataDir, 1_800_000_000_000)
  await status(w.env, '0.1.0')
  expect(w.out).toContain('backup: last made 2027-01-15T08:00:00.000Z')
  // An old backup is stated, never nagged about.
  expect(w.out.filter((line) => line.includes('backup')).join('\n')).not.toMatch(/warning|old|overdue/i)
})

test('status mentions a store a restore kept, with the way back, and nothing when there is none', async () => {
  const w = make({ withLibrary: false })
  mkdirSync(w.dataDir, { recursive: true })
  await status(w.env, '0.1.0')
  expect(w.out.some((line) => line.includes('kinfold-replaced'))).toBe(false)
  w.out.length = 0
  const kept = join(w.dataDir, 'memory.db.kinfold-replaced')
  writeFileSync(kept, 'SQLite format 3\u0000 and the rest of a store')
  utimesSync(kept, 1_800_000_000, 1_800_000_000)
  await status(w.env, '0.1.0')
  expect(w.out).toContain(`kept store: the store replaced on 2027-01-15T08:00:00.000Z is kept as ${kept}; kinfold restore --undo switches back to it`)
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

// ---- automatic updates -------------------------------------------------------

const AUTO_RECORD = { channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1 }
const ON_DATE = 1_800_000_000_000

function installed(record: Record<string, unknown> = AUTO_RECORD): FakeWorld {
  const w = make({ withLibrary: false })
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(join(w.dataDir, 'install.json'), JSON.stringify(record))
  w.env = { ...w.env, service: fakeService() }
  return w
}

async function linesOf(w: FakeWorld, running = '0.2.0'): Promise<string[]> {
  w.out.length = 0
  await status(w.env, running)
  return [...w.out]
}

test('status says auto-update is on, or off and why', async () => {
  const w = installed()
  expect(await linesOf(w)).toContain('auto-update: on (patch releases install themselves)')
  writeFileSync(join(w.dataDir, 'install.json'), JSON.stringify({ ...AUTO_RECORD, autoUpdate: false }))
  expect(await linesOf(w)).toContain('auto-update: off (turned off)')
  writeFileSync(join(w.dataDir, 'install.json'), JSON.stringify({ ...AUTO_RECORD, updateCheck: false }))
  expect(await linesOf(w)).toContain('auto-update: off (the update check is off)')
  writeFileSync(join(w.dataDir, 'install.json'), JSON.stringify(AUTO_RECORD))
  w.env = { ...w.env, envVars: { KINFOLD_NO_AUTO_UPDATE: '1' } }
  // The daemon runs under the service, not this shell: the variable alone turns nothing off there.
  expect(await linesOf(w)).toContain('auto-update: on (patch releases install themselves); KINFOLD_NO_AUTO_UPDATE is set in this shell only, which the daemon does not read: run kinfold install --no-auto-update to turn it off')
})

test('status says auto-update is manual where the daemon cannot restart itself, and why', async () => {
  const w = installed()
  w.env = { ...w.env, service: fakeService({ running: false }) }
  expect(await linesOf(w)).toContain('auto-update: manual (the daemon is not run by the FakeService; run kinfold update for each release)')
  w.env = { ...w.env, service: null }
  expect(await linesOf(w)).toContain('auto-update: manual (no background service runs the daemon here; run kinfold update for each release)')
})

test('a Linux user service without systemd-run cannot promise a detached update', () => {
  const w = installed()
  const linux = { ...w.env, platform: 'linux' as const, envVars: { XDG_RUNTIME_DIR: '/run/user/1000' } }
  const managerOnly = (path: string): boolean => path === '/run/user/1000/systemd/private'
  expect(autoUpdateBlocker(linux, true, managerOnly)).toBe('systemd-run is not installed, so an update started by the service would be stopped with it')
  expect(autoUpdateBlocker(linux, true, (path) => managerOnly(path) || path === '/usr/bin/systemd-run')).toBeNull()
  expect(autoUpdateBlocker(w.env, true)).toBeNull()
})

test('status shows the last automatic update, and the last error with when it is tried again', async () => {
  const w = installed()
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.2.1', checkedAt: ON_DATE, notified: {} })
  mergeAutoState(w.dataDir, {
    updated: { version: '0.2.0', previous: '0.1.9', at: ON_DATE },
    failure: { version: '0.2.1', at: ON_DATE, reason: 'the program download answered 503; nothing was changed' },
  })
  const lines = await linesOf(w)
  expect(lines).toContain('  last update: 0.2.0 (was 0.1.9) on 2027-01-15T08:00:00.000Z')
  expect(lines).toContain('  last error: 0.2.1 on 2027-01-15T08:00:00.000Z: the program download answered 503; nothing was changed. It is tried again after the next daily check.')
  // After a failure the user is told the release exists, so they can install it by hand.
  expect(lines).toContain('update: Kinfold 0.2.1 is available. Run `kinfold update`.')
  // Once that release is installed the error is history.
  expect((await linesOf(w, '0.2.1')).some((line) => line.includes('last error'))).toBe(false)
})

test('status says a patch release will install itself, and offers it by hand where it will not', async () => {
  const w = installed()
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.2.1', checkedAt: ON_DATE, notified: {} })
  expect(await linesOf(w)).toContain('update: Kinfold 0.2.1 will install itself once no agent has been active for 10 minutes')
  w.env = { ...w.env, service: fakeService({ running: false }) }
  expect(await linesOf(w)).toContain('update: Kinfold 0.2.1 is available. Run `kinfold update`.')
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.3.0', checkedAt: ON_DATE, notified: {} })
  w.env = { ...w.env, service: fakeService() }
  expect(await linesOf(w)).toContain('update: Kinfold 0.3.0 is available. Run `kinfold update`.')
})

test('status stays read-only: it marks no notice shown', async () => {
  const w = installed()
  mergeAutoState(w.dataDir, { updated: { version: '0.2.0', previous: '0.1.9', at: ON_DATE } })
  const before = snapshotTree(w.dataDir)
  await linesOf(w)
  await linesOf(w)
  expect(snapshotTree(w.dataDir)).toEqual(before)
})

test('status shows the agent homes saved for automatic updates', async () => {
  const w = installed({ ...AUTO_RECORD, agentHomes: { CODEX_HOME: '/opt/codex-home', XDG_CONFIG_HOME: '/home/u/.xdg' } })
  expect(await linesOf(w)).toContain('  agent homes used by an automatic update: CODEX_HOME=/opt/codex-home, XDG_CONFIG_HOME=/home/u/.xdg')
  const none = installed()
  expect((await linesOf(none)).some((line) => line.includes('agent homes'))).toBe(false)
})

test('status says a blocker is tried again on a change, not daily', async () => {
  const w = installed()
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.2.1', checkedAt: ON_DATE, notified: {} })
  mergeAutoState(w.dataDir, { failure: { version: '0.2.1', at: ON_DATE, reason: 'the daemon is not run by a background service here; run kinfold update', blocked: true, running: '0.2.0' } })
  expect(await linesOf(w)).toContain('  last error: 0.2.1 on 2027-01-15T08:00:00.000Z: the daemon is not run by a background service here; run kinfold update. It is tried again when the daemon restarts or the install changes.')
})

test('status says whether typing kinfold finds a program, and reads only', async () => {
  world = createWorld()
  const w = world
  const bin = join(w.dataDir, 'bin', 'kinfold')
  w.env = { ...w.env, mode: { kind: 'program', binPath: bin } }
  const before = snapshotTree(w.home)
  expect(await linesOf(w)).toContain(`kinfold command: not on PATH; run ${bin} install in a terminal to add it`)
  expect(snapshotTree(w.home)).toEqual(before)
})

// ---- on a terminal -------------------------------------------------------------

const drawn = (term: ReturnType<typeof fakeTerminal>): string[] =>
  term.output().split('\n').map((line) => line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').trimEnd()).filter((line) => line !== '')

test('on a terminal status is sections of marked rows, and ends on the command to run next', async () => {
  const term = fakeTerminal([])
  const w = make({ withLibrary: false, terminal: term })
  const before = snapshotTree(w.home)
  expect(await runFramed(w.env, 'status', (env) => status(env))).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  expect(w.out).toEqual([])
  const lines = drawn(term)
  expect(lines[0]).toMatch(/^Kinfold \S+ status$/)
  expect(lines.filter((line) => !line.startsWith(' ')).slice(1, -1)).toEqual(['Agents', 'Daemon', 'Memory', 'Observers', 'Updates', 'Command'])
  // Found and not wired is worth a look; not installed is only stated.
  expect(lines).toContain('  ! Claude Code: 2.1.310, not wired · capture, context, search')
  expect(lines).toContain('  ! OpenCode: 2.1.4, not wired · capture, search')
  expect(lines).toContain('  Not installed: 19 other supported agents')
  expect(lines).toContain('  x daemon /health: down (nothing answers on 127.0.0.1:37811 (TypeError))')
  expect(lines).toContain('  + keychain openrouter: present')
  expect(lines).toContain('  + duplicate wiring: none in this directory')
  expect(lines).toContain('  ! kinfold command: not on PATH; a checkout has no installed program')
  expect(lines.at(-1)).toBe('Start the daemon with: kinfold install')
})

test('a wired agent and a running daemon get the ok mark, and the outro points at the dashboard', async () => {
  const term = fakeTerminal([])
  const w = make({ opencodeVersion: null })
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  w.env = { ...w.env, terminal: term }
  expect(await runFramed(w.env, 'status', (env) => status(env))).toBe(EXIT_OK)
  const lines = drawn(term)
  expect(lines.some((line) => /^ {2}\+ Claude Code: .*, wired/.test(line))).toBe(true)
  expect(lines.some((line) => /^ {2}\+ daemon \/health: up on 127\.0\.0\.1:/.test(line))).toBe(true)
  expect(lines.at(-1)).toBe('Open the dashboard with: kinfold dashboard')
  // Only the observers that were chosen: a built-in default for an agent that is not wired says nothing.
  const observers = lines.slice(lines.indexOf('Observers') + 1, lines.indexOf('Updates'))
  expect(observers).toEqual(['  claude-code: claude-cli/haiku; source host'])
})

test('the marks are right for the lines status really prints', () => {
  const marks = (line: string): string => statusMark(line)
  // A store that is encrypted with its key gone is the worst row on the screen, never a green one.
  expect(marks('database: encrypted (keychain db-key present)')).toBe('ok')
  expect(marks('database: encrypted (keychain db-key missing)')).toBe('fail')
  expect(marks('database: encrypted (key store unknown)')).toBe('warn')
  expect(marks('database: plaintext; kinfold encrypt converts it (keychain db-key missing)')).toBe('warn')
  expect(marks('database: not created yet (keychain db-key missing)')).toBe('none')
  // Every line that calls itself a warning is one, wherever it is indented.
  expect(marks('warning: memory.db is encrypted and the Keychain has no db-key under kinfold; restore it with kinfold key recover')).toBe('warn')
  expect(marks('  warning: /home/u/.kinfold/hmac.key still exists; run kinfold install to finish the migration')).toBe('warn')
  expect(marks('warning: this directory also wires Kinfold, so its events would be captured twice:')).toBe('warn')
  expect(marks('data dir /home/u/.kinfold: 2 of 19 need fixing (install fixes them):')).toBe('warn')
  expect(marks('  codex: invalid setting (unknown provider)')).toBe('warn')
  expect(marks('data dir /home/u/.kinfold: modes ok (19 checked, dirs 0700, files 0600, program 0755)')).toBe('none')
})

test('an agent whose wiring is stale or partial is a row to look at, and says which', async () => {
  const term = fakeTerminal([])
  const w = make({ opencodeVersion: null, terminal: term })
  // Hooks from an older install: an entry that runs another program path.
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  const stale = mergeSamHooks({}, { entry: entryCommand({ kind: 'program', binPath: '/old/place/bin/kinfold' }, 'hook', w.dataDir) }).settings
  writeFileSync(paths.claudeSettings, JSON.stringify(stale))
  expect(await runFramed(w.env, 'status', (env) => status(env))).toBe(EXIT_OK)
  const row = drawn(term).find((line) => line.includes('Claude Code:')) ?? ''
  expect(row).toMatch(/^ {2}! Claude Code: 2\.1\.310, wiring (stale|partial) · /)
})

test('an agent that is not installed and a key no observer uses are stated, not flagged', async () => {
  const term = fakeTerminal([])
  // Claude Code only, on its CLI observer: nothing uses OpenCode's MCP entry or the OpenRouter key.
  const w = make({ opencodeVersion: null, keychainRefs: [] })
  expect(await install(w.env, { ...YES, flags: [{ host: 'claude-code', provider: 'claude-cli', model: 'haiku' }] })).toBe(EXIT_OK)
  w.env = { ...w.env, terminal: term }
  expect(await runFramed(w.env, 'status', (env) => status(env))).toBe(EXIT_OK)
  const lines = drawn(term)
  expect(lines.some((line) => /^ {4}opencode: no in /.test(line))).toBe(true)
  expect(lines.some((line) => /^ {2}! opencode: no in /.test(line))).toBe(false)
  expect(lines).toContain('  keychain openrouter: missing')
  expect(lines).not.toContain('  ! keychain openrouter: missing')
})

test('with no observer chosen the section says so in one row', async () => {
  const term = fakeTerminal([])
  const w = make({ claudeVersion: null, opencodeVersion: null })
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  w.env = { ...w.env, terminal: term }
  expect(await runFramed(w.env, 'status', (env) => status(env))).toBe(EXIT_OK)
  const lines = drawn(term)
  expect(lines.slice(lines.indexOf('Observers') + 1, lines.indexOf('Updates'))).toEqual(['  every agent is on its built-in default'])
})

test('each kind of status line gets the mark its words call for', () => {
  const marks = (line: string): string => statusMark(line)
  expect(marks('daemon /health: up on 127.0.0.1:37811 version 0.3.0')).toBe('ok')
  expect(marks('daemon /health: down (nothing answers)')).toBe('fail')
  expect(marks('service (LaunchAgent): config present; running: yes')).toBe('ok')
  expect(marks('service (LaunchAgent): config missing; running: no')).toBe('warn')
  expect(marks('database: encrypted (keychain db-key present)')).toBe('ok')
  expect(marks('keychain openrouter: missing')).toBe('warn')
  expect(marks('update: Kinfold 0.3.1 is available. Run `kinfold update`.')).toBe('warn')
  expect(marks('update: none known (never checked)')).toBe('ok')
  expect(marks('auto-update: on (patch releases install themselves)')).toBe('ok')
  expect(marks('  last error: 0.3.1 on 2026-11-15: no network')).toBe('warn')
  expect(marks('kinfold command: on PATH at /home/u/.local/bin/kinfold (this install)')).toBe('ok')
  expect(marks("kinfold command: on PATH at /usr/bin/kinfold, which is not this install's program")).toBe('warn')
  expect(marks('  claude-code: yes in /home/u/.claude.json')).toBe('ok')
  expect(marks('semantic search: off (no pinned sqlite-vec build)')).toBe('none')
  expect(marks('semantic search: on')).toBe('ok')
  expect(marks('semantic search: off in the running daemon; restart it (kinfold install restarts it)')).toBe('warn')
  expect(marks('update check: off')).toBe('none')
})

test('status names the key each API provider reads and the address of an endpoint provider', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const realFetch = w.env.fetch
  w.env.fetch = async (url, init) => {
    if (new URL(url).pathname !== '/observer/settings') return realFetch(url, init)
    const effective = [
      { host: 'claude-code', settings: { provider: 'anthropic-api', model: 'claude-haiku-5-5', credentialRef: null, enabled: true, source: 'host' } },
      { host: 'opencode', settings: { provider: 'openai-compatible', model: 'llama3.2', credentialRef: null, enabled: true, source: 'host', endpoint: 'http://127.0.0.1:11434/v1' } },
    ]
    return new Response(JSON.stringify({ rows: [], effective }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  w.out.length = 0
  await status(w.env)
  expect(w.out).toContain('  claude-code: anthropic-api/claude-haiku-5-5 key anthropic; source host')
  expect(w.out).toContain('  opencode: openai-compatible/llama3.2 at http://127.0.0.1:11434/v1; source host')
  expect(w.out).toContain('keychain anthropic: missing')
})

const stageFor = (w: FakeWorld, version: string): void => {
  const dir = join(w.dataDir, 'updates')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `kinfold-${version}`), 'program')
  const stat = statSync(join(dir, `kinfold-${version}`))
  writeFileSync(join(dir, 'staged.json'), JSON.stringify({ staged: { version, asset: 'kinfold-darwin-arm64', sha256: 'a'.repeat(64), size: stat.size, mtimeMs: stat.mtimeMs, at: 1 }, failure: null }))
}

test('status says a larger release is being downloaded, then that it is ready for a yes', async () => {
  const w = installed()
  w.env = { ...w.env, arch: 'arm64' }
  writeUpdateState(w.dataDir, { lastAttemptAt: 1, latestVersion: '0.3.0', checkedAt: ON_DATE, notified: {}, beta: false, release: { version: '0.3.0', prerelease: false, changes: ['A.', 'BREAKING: B.'], breaking: ['BREAKING: B.'] } })
  expect(await linesOf(w)).toContain('update: downloading Kinfold 0.3.0 so it is ready to install')
  stageFor(w, '0.3.0')
  expect(await linesOf(w)).toContain('update: Kinfold 0.3.0 is ready · 2 changes, 1 breaking · kinfold update to install')
})

test('status names the beta channel when it is on', async () => {
  expect(await linesOf(installed({ ...AUTO_RECORD, beta: true }))).toContain('beta releases: on (each one waits for your yes)')
  expect((await linesOf(installed())).some((line) => line.startsWith('beta releases'))).toBe(false)
})

test('status says a running prerelease reads the beta channel even with it off in the record', async () => {
  expect(await linesOf(installed(), '0.6.0-beta.1')).toContain('beta releases: on while this prerelease runs (each one waits for your yes); kinfold install --beta keeps them after 0.6.0')
})
