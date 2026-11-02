import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { samHookGroup } from './claude-hooks'
import { installPaths } from './env'
import { EXIT_OK, install } from './install'
import { mcpPaths, mcpTarget } from './mcp-wiring'
import { status } from './status'
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
    `mcp server ${mcpTarget(w.env).serverScript}:`,
    `  claude-code: no in ${mcpPaths(w.env).claudeUserConfig}`,
    `  opencode: no in ${mcpPaths(w.env).opencodeConfig}`,
    'launch agent: plist missing; loaded: no',
    'daemon /health: down (nothing answers on 127.0.0.1:37811 (TypeError))',
    'semantic search: off (no pinned sqlite-vec build for darwin-test-arch)',
    'database: not created yet (keychain db-key missing)',
    'disk encryption: could not check (fdesetup exit 127)',
    'observer settings: unknown (daemon.json or daemon.token is missing; the daemon is not running)',
    'keychain openrouter: present',
    'hmac keys: none yet; keychain hmac-master missing, hmac-legacy missing',
    `  sub-keys in ${join(w.dataDir, 'hmac.d')}: none`,
    `data dir ${w.dataDir}: missing`,
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
  expect(out).toMatch(/daemon \/health: up on 127\.0\.0\.1:\d+ version 0\.0\.1 schema \d+ pid \d+, LaunchAgent/)
  expect(out).toContain('  claude-code: claude-cli/haiku; source host')
  expect(out).toContain('  opencode: openrouter/openrouter/auto key openrouter; source host')
  expect(out).toMatch(/data dir .*: modes ok/)
})

test('stale paths, loose modes and duplicate project wiring are each reported', async () => {
  const w = make({ withLibrary: false })
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, JSON.stringify({ hooks: { Stop: [samHookGroup('Stop', { bunPath: BUN, hookScript: '/old/src/cli/hook.ts' })] } }))
  mkdirSync(paths.opencodePluginsDir, { recursive: true })
  writeFileSync(paths.opencodePlugin, 'export { default } from "/old/src/plugins/opencode.ts";\n')
  mkdirSync(w.dataDir, { recursive: true })
  writeFileSync(join(w.dataDir, 'memory.db'), '')
  chmodSync(join(w.dataDir, 'memory.db'), 0o644)
  chmodSync(w.dataDir, 0o700)
  mkdirSync(join(w.cwd, '.claude'))
  writeFileSync(join(w.cwd, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [samHookGroup('Stop', { bunPath: BUN, hookScript: '/x/src/cli/hook.ts' })] } }))
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
