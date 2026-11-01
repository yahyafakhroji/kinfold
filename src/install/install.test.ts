import { afterEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_HOOK_EVENTS, samHookGroup } from './claude-hooks'
import { getObserverSettings } from './daemon-client'
import { installPaths } from './env'
import { EXIT_OK, install } from './install'
import { LAUNCHCTL, launchdPath } from './launch-agent'
import { BUN, type FakeWorld, UID, YES, createWorld } from './test-support'

const CLAUDE = '2.1.310 (Claude Code)'
const OPENCODE = 'opencode v2.1.4'
let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function both(options: Parameters<typeof createWorld>[0] = {}): FakeWorld {
  world = createWorld({ claudeVersion: CLAUDE, opencodeVersion: OPENCODE, keychainRefs: ['openrouter'], ...options })
  return world
}

const launchctlCalls = (w: FakeWorld): string[][] => w.commands.filter((c) => c.argv[0] === LAUNCHCTL).map((c) => [...c.argv])

async function savedRows(w: FakeWorld): Promise<{ host: string; provider: string; model: string; credentialRef: string | null }[]> {
  const read = await getObserverSettings(w.env)
  if (!read.ok) throw new Error(read.reason)
  return read.view.rows.map(({ host, provider, model, credentialRef }) => ({ host, provider, model, credentialRef }))
}

test('a fresh install wires both hosts, starts the LaunchAgent and saves both observers through the daemon', async () => {
  const w = both()
  const paths = installPaths(w.env)
  expect(await install(w.env, YES)).toBe(EXIT_OK)

  const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'))
  for (const event of CLAUDE_HOOK_EVENTS) expect(settings.hooks[event]).toEqual([samHookGroup(event, { bunPath: BUN, hookScript: paths.hookScript })])
  expect(readFileSync(paths.opencodePlugin, 'utf8')).toContain(`export { default } from ${JSON.stringify(join(w.projectRoot, 'src/plugins/opencode.ts'))};`)
  expect(launchctlCalls(w)).toEqual([
    [LAUNCHCTL, 'print', `gui/${UID}/dev.kinfold.daemon`],
    [LAUNCHCTL, 'bootstrap', `gui/${UID}`, join(w.home, 'Library/LaunchAgents/dev.kinfold.daemon.plist')],
  ])
  expect(await savedRows(w)).toEqual([
    { host: 'claude-code', provider: 'claude-cli', model: 'haiku', credentialRef: null },
    { host: 'opencode', provider: 'openrouter', model: 'openrouter/auto', credentialRef: 'openrouter' },
  ])
  expect(w.checks.map((s) => `${s.provider}/${s.model}`)).toEqual(['claude-cli/haiku', 'openrouter/openrouter/auto'])
  expect(statSync(w.dataDir).mode & 0o777).toBe(0o700)
  expect(statSync(paths.logsDir).mode & 0o777).toBe(0o700)
  expect(statSync(paths.logFile).mode & 0o777).toBe(0o600)
  expect(w.fetches.filter((f) => f.startsWith('PUT'))).toEqual(['PUT /observer/settings', 'PUT /observer/settings'])
})

test('the plist names the absolute bun and main.ts, keeps the daemon alive and logs to <dataDir>/logs', async () => {
  const w = both()
  await install(w.env, YES)
  const plist = readFileSync(installPaths(w.env).launchAgentPlist, 'utf8')
  expect(plist).toContain(`<key>ProgramArguments</key>\n  <array><string>${BUN}</string><string>${join(w.projectRoot, 'src/daemon/main.ts')}</string></array>`)
  expect(plist).toContain('<key>RunAtLoad</key><true/>')
  expect(plist).toContain('<key>KeepAlive</key><true/>')
  expect(plist).toContain(`<key>StandardOutPath</key><string>${join(w.dataDir, 'logs/daemon.log')}</string>`)
  expect(plist).toContain(`<key>StandardErrorPath</key><string>${join(w.dataDir, 'logs/daemon.log')}</string>`)
  expect(plist).toContain(`<key>KINFOLD_DATA_DIR</key><string>${w.dataDir}</string>`)
  expect(plist).toContain('<key>PATH</key><string>/opt/fake/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>')
})

test('the plist PATH holds bun, the dirs of claude and git, then system dirs, whatever else the shell PATH has', () => {
  const which = (command: string): string | null => ({ claude: '/home/u/.local/bin/claude', git: '/opt/homebrew/bin/git' })[command] ?? null
  const noisy = '/repo/node_modules/.bin:/home/u/.local/bin:/opt/homebrew/bin:/usr/local/games:relative/bin'
  const quiet = '/opt/homebrew/bin:/home/u/.local/bin'
  const expected = '/opt/bun/bin:/home/u/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  expect(launchdPath({ bunPath: '/opt/bun/bin/bun', pathEnv: noisy }, which)).toBe(expected)
  expect(launchdPath({ bunPath: '/opt/bun/bin/bun', pathEnv: quiet }, which)).toBe(expected)
})

test('unrelated keys and hooks survive, the backup is written once, and a re-run is byte-identical', async () => {
  const w = both()
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  const original = `${JSON.stringify({ theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } }, null, 2)}\n`
  writeFileSync(paths.claudeSettings, original)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const first = readFileSync(paths.claudeSettings, 'utf8')
  const parsed = JSON.parse(first)
  expect(parsed.theme).toBe('dark')
  expect(parsed.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }])
  const backups = readdirSync(paths.claudeDir).filter((name) => name.includes('.sam-backup-'))
  expect(backups).toHaveLength(1)
  expect(readFileSync(join(paths.claudeDir, backups[0]!), 'utf8')).toBe(original)
  expect(statSync(join(paths.claudeDir, backups[0]!)).mode & 0o777).toBe(0o600)

  const mtimes = [paths.claudeSettings, paths.opencodePlugin, paths.launchAgentPlist].map((path) => statSync(path).mtimeMs)
  w.commands.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(readFileSync(paths.claudeSettings, 'utf8')).toBe(first)
  expect([paths.claudeSettings, paths.opencodePlugin, paths.launchAgentPlist].map((path) => statSync(path).mtimeMs)).toEqual(mtimes)
  expect(readdirSync(paths.claudeDir).filter((name) => name.includes('.sam-backup-'))).toHaveLength(1)
  expect(launchctlCalls(w).map((argv) => argv[1])).toEqual(['print'])
})

test('a stale hook path and a stale plugin path from a moved checkout are replaced', async () => {
  const w = both()
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  const old = { bunPath: BUN, hookScript: '/old/checkout/src/cli/hook.ts' }
  writeFileSync(paths.claudeSettings, JSON.stringify({ hooks: { Stop: [samHookGroup('Stop', old)] } }))
  mkdirSync(paths.opencodePluginsDir, { recursive: true })
  writeFileSync(paths.opencodePlugin, 'export { default } from "/old/checkout/src/plugins/opencode.ts";\n')
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const text = readFileSync(paths.claudeSettings, 'utf8')
  expect(text).not.toContain('/old/checkout')
  expect(JSON.parse(text).hooks.Stop).toEqual([samHookGroup('Stop', { bunPath: BUN, hookScript: paths.hookScript })])
  expect(readFileSync(paths.opencodePlugin, 'utf8')).not.toContain('/old/checkout')
  expect(w.out.some((line) => line.includes('replace SAM hooks for Stop'))).toBe(true)
  expect(w.out.some((line) => line.includes('replacing a stale plugin path'))).toBe(true)
})

test('settings.json that does not parse aborts the install and nothing is written', async () => {
  const w = both({ withLibrary: false })
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, '{ "theme": "dark", oops ')
  expect(await install(w.env, YES)).toBe(1)
  expect(readFileSync(paths.claudeSettings, 'utf8')).toBe('{ "theme": "dark", oops ')
  expect(readdirSync(paths.claudeDir)).toEqual(['settings.json'])
  expect(existsSync(paths.launchAgentPlist)).toBe(false)
  expect(existsSync(w.dataDir)).toBe(false)
  expect(launchctlCalls(w).map((argv) => argv[1])).toEqual(['print'])
  expect(w.out.at(-1)).toBe(`install failed: ${paths.claudeSettings} is not valid JSON; leaving it untouched`)
})

test('OpenCode 1.x is refused while Claude Code still installs', async () => {
  const w = both({ opencodeVersion: '1.18.35' })
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(existsSync(installPaths(w.env).claudeSettings)).toBe(true)
  expect(existsSync(installPaths(w.env).opencodePlugin)).toBe(false)
  expect(w.out).toContain('host opencode 1.18.35: skip (OpenCode 1.18.35 is not supported: the plugin needs OpenCode 2.0 or later)')
  expect((await savedRows(w)).map((row) => row.host)).toEqual(['claude-code'])
})

test('--observer sets one host and --yes keeps the default for the other', async () => {
  const w = both()
  const options = { ...YES, flags: [{ host: 'opencode' as const, provider: 'claude-cli' as const, model: 'sonnet' }] }
  expect(await install(w.env, options)).toBe(EXIT_OK)
  expect(await savedRows(w)).toEqual([
    { host: 'claude-code', provider: 'claude-cli', model: 'haiku', credentialRef: null },
    { host: 'opencode', provider: 'claude-cli', model: 'sonnet', credentialRef: null },
  ])
})

test('the data dir permission fix reports each path with its old and new mode', async () => {
  const w = both({ opencodeVersion: null })
  mkdirSync(join(w.dataDir, 'spool'), { recursive: true })
  writeFileSync(join(w.dataDir, 'memory.db'), '', { mode: 0o644 })
  writeFileSync(join(w.dataDir, 'spool', 'e.json'), '{}', { mode: 0o640 })
  chmodSync(join(w.dataDir, 'memory.db'), 0o644)
  chmodSync(join(w.dataDir, 'spool', 'e.json'), 0o640)
  chmodSync(w.dataDir, 0o755)
  chmodSync(join(w.dataDir, 'spool'), 0o755)
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const lines = w.out.join('\n')
  for (const expected of ['chmod <dataDir>/. 0755 -> 0700', 'chmod <dataDir>/memory.db 0644 -> 0600', 'chmod <dataDir>/spool 0755 -> 0700', 'chmod <dataDir>/spool/e.json 0640 -> 0600']) {
    expect(lines).toContain(expected)
  }
  expect(statSync(join(w.dataDir, 'memory.db')).mode & 0o777).toBe(0o600)
  expect(statSync(join(w.dataDir, 'spool')).mode & 0o777).toBe(0o700)
})
