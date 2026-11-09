import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mergeSamHooks, samHookGroup } from './claude-hooks'
import { entryCommand, entryIdentity, installedProgramPath } from './entry'
import { installPaths } from './env'
import { CODEX_HOOK_SPEC, mergeHostHooks } from './host-hooks'
import { EXIT_OK, install } from './install'
import { mcpPaths, mcpTarget } from './mcp-wiring'
import { VERSION } from '../version'
import { status } from './status'
import { writeUpdateState } from '../update/state'
import { BUN, type FakeWorld, YES, createWorld, snapshotTree } from './test-support'

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
    `  claude-code: detected 2.1.310 (Claude Code); wired: no (no settings.json) in ${paths.claudeSettings}`,
    `  opencode: detected 2.1.4; wired: no in ${paths.opencodePlugin}`,
    `  codex: not detected (not found (no codex on PATH, no Codex.app)); wired: no (no hooks.json) in ${paths.codexHooks}`,
    `  cursor: not detected (not found (no cursor-agent or cursor on PATH, no Cursor.app)); wired: no (no hooks.json) in ${paths.cursorHooks}`,
    `mcp server ${entryIdentity(w.env.mode, 'mcp', w.env.dataDir)}:`,
    `  claude-code: no in ${mcpPaths(w.env).claudeUserConfig}`,
    `  opencode: no in ${mcpPaths(w.env).opencodeConfig}`,
    'launch agent: plist missing; loaded: no',
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

test('after install: wired, loaded, healthy, observers with their source, modes ok', async () => {
  const w = make()
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  w.out.length = 0
  await status(w.env)
  const out = w.out.join('\n')
  expect(out).toContain('claude-code: detected 2.1.310 (Claude Code); wired: yes')
  expect(out).toContain('opencode: detected 2.1.4; wired: yes')
  expect(out).toContain('launch agent: plist present; loaded: yes')
  expect(out).toMatch(/daemon \/health: up on 127\.0\.0\.1:\d+ version \S+ schema \d+ pid \d+, LaunchAgent/)
  expect(out).toContain(` version ${VERSION} schema `)
  expect(out).toContain('  claude-code: claude-cli/haiku; source host')
  expect(out).toContain('  opencode: openrouter/openrouter/auto key openrouter; source host')
  expect(out).toMatch(/data dir .*: modes ok/)
})

test('stale paths, loose modes and duplicate project wiring are each reported', async () => {
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

test('status reports modes ok after a program install', async () => {
  const { w, options } = programInstallWorld()
  expect(await install(w.env, options)).toBe(EXIT_OK)
  w.out.length = 0
  expect(await status(w.env)).toBe(EXIT_OK)
  const text = w.out.join('\n')
  expect(text).toContain('modes ok')
  expect(text).toContain('program 0755')
  expect(text).not.toContain('bin/kinfold 0755 -> 0600')
})

test('status shows the program-form wiring', async () => {
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
