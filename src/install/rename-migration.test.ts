import { afterEach, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunningDaemon } from '../daemon/daemon'
import { LEGACY_LAUNCH_AGENT_LABEL, LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME } from '../names'
import { newDbKey } from '../sqlite/keys'
import { fileState } from '../sqlite/open'
import { openStore } from '../store/db'
import { checkHealth, readDaemonInfo } from './daemon-client'
import { installPaths } from './env'
import { EXIT_FAILED, EXIT_OK, install } from './install'
import { LAUNCHCTL } from './launch-agent'
import { claudeMcpEntry, openCodeMcpEntry, removeMcpEntryNamed } from './mcp-config'
import { isOwnShim, shimContent } from './opencode-shim'
import { mcpPaths, mcpTarget } from './mcp-wiring'
import { renameMigrationActions } from './rename-migration'
import { type FakeWorld, UID, YES, createWorld, placeBuiltLibrary, snapshotTree, startWorldDaemon } from './test-support'

const CLAUDE = '2.1.310 (Claude Code)'
const OPENCODE = 'opencode v2.1.4'
const hex = (): string => randomBytes(32).toString('hex')
/** Distinct per test run, so a value that leaks anywhere is found by a plain substring search. */
const VALUES: Readonly<Record<string, string>> = {
  openrouter: `sk-or-v1-TESTONLY${randomBytes(12).toString('hex')}`,
  'hmac-master': hex(),
  'hmac-legacy': hex(),
  'db-key': newDbKey(),
}
const REFS = Object.keys(VALUES)

let world: FakeWorld | null = null
const extraDaemons: RunningDaemon[] = []
afterEach(async () => {
  for (const daemon of extraDaemons.splice(0)) await daemon.stop()
  await world?.cleanup()
  world = null
})

const legacyShim = (pluginEntry: string): string => [
  '// shared-agent-memory: written by `sam install`, removed by `sam uninstall`.',
  '// OpenCode 2.x loads every plugin in this folder; the plugin itself lives in',
  '// the checkout below. Its default export must be { id, setup } and nothing else.',
  `export { default } from ${JSON.stringify(pluginEntry)};`,
  '',
].join('\n')

/** What a Shared Agent Memory install left on the machine: store, plist, Keychain entries, MCP entries, shim. */
function legacyWorld(options: { running?: boolean } = {}): FakeWorld {
  const w = createWorld({ claudeVersion: CLAUDE, opencodeVersion: OPENCODE, withLibrary: false, legacyKeychainRefs: REFS })
  world = w
  for (const ref of REFS) w.legacyKeychainValues.set(ref, VALUES[ref]!)
  const paths = installPaths(w.env)
  placeBuiltLibrary(paths.legacyDataDir, 'darwin')
  openStore(paths.legacyDataDir, { keys: { name: 'test', read: () => VALUES['db-key']!, exists: () => true } }).db.close()
  mkdirSync(paths.launchAgentsDir, { recursive: true })
  writeFileSync(paths.legacyLaunchAgentPlist, `<plist><dict><key>Label</key><string>${LEGACY_LAUNCH_AGENT_LABEL}</string></dict></plist>\n`)
  const target = mcpTarget(w.env)
  const mcp = mcpPaths(w.env)
  writeFileSync(mcp.claudeUserConfig, `${JSON.stringify({ mcpServers: { [LEGACY_MCP_SERVER_NAME]: claudeMcpEntry(target), other: { type: 'stdio', command: 'x' } } }, null, 2)}\n`)
  mkdirSync(paths.opencodePluginsDir, { recursive: true })
  writeFileSync(mcp.opencodeConfig, `${JSON.stringify({ mcp: { [LEGACY_MCP_SERVER_NAME]: openCodeMcpEntry(target) }, theme: 'dark' }, null, 2)}\n`)
  writeFileSync(paths.legacyOpencodePlugin, legacyShim(paths.pluginEntry))
  if (options.running === true) {
    w.launchd.legacyLoaded = true
    w.launchd.legacyDaemon = startWorldDaemon(w, paths.legacyDataDir)
  }
  return w
}

const callLine = (args: readonly string[]): string => args.join(' ')
const deletes = (w: FakeWorld): string[] => w.securityCalls.map((c) => callLine(c.args)).filter((line) => line.startsWith('delete-generic-password'))
const adds = (w: FakeWorld): number => w.securityCalls.filter((c) => c.stdin !== undefined).length

function expectNoValueLeaked(w: FakeWorld): void {
  const argv = w.securityCalls.map((c) => callLine(c.args)).join('\n')
  const commands = w.commands.map((c) => c.argv.join(' ')).join('\n')
  const out = w.out.join('\n')
  for (const value of Object.values(VALUES)) {
    expect(argv).not.toContain(value)
    expect(commands).not.toContain(value)
    expect(out).not.toContain(value)
  }
}

function expectLegacyUntouched(w: FakeWorld, opencodeBefore: string): void {
  const paths = installPaths(w.env)
  expect(lstatSync(paths.legacyDataDir).isDirectory()).toBe(true)
  expect(existsSync(w.dataDir)).toBe(false)
  for (const ref of REFS) expect(w.legacyKeychainValues.get(ref)).toBe(VALUES[ref])
  expect([...w.legacyKeychain].sort()).toEqual([...REFS].sort())
  expect(deletes(w)).toEqual([])
  expect(existsSync(paths.legacyLaunchAgentPlist)).toBe(true)
  expect(readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')).toBe(opencodeBefore)
  expect(existsSync(paths.legacyOpencodePlugin)).toBe(true)
}

test('a legacy install moves: entries copied and read back before any delete, data dir renamed with a symlink, wiring renamed', async () => {
  const w = legacyWorld({ running: true })
  const paths = installPaths(w.env)
  const storeInode = statSync(join(paths.legacyDataDir, 'memory.db')).ino
  expect(await install(w.env, YES)).toBe(EXIT_OK)

  // The store moved (same inode), stays encrypted, and the new daemon opened it with the keys now under kinfold only.
  expect(statSync(join(w.dataDir, 'memory.db')).ino).toBe(storeInode)
  expect(fileState(join(w.dataDir, 'memory.db'))).toBe('encrypted')
  expect((await checkHealth(w.env, readDaemonInfo(w.dataDir).port)).up).toBe(true)
  expect(lstatSync(paths.legacyDataDir).isSymbolicLink()).toBe(true)
  expect(readlinkSync(paths.legacyDataDir)).toBe(w.dataDir)

  for (const ref of REFS) expect(w.keychainValues.get(ref)).toBe(VALUES[ref])
  expect(w.legacyKeychain.size).toBe(0)
  const lines = w.securityCalls.map((c) => callLine(c.args))
  for (const ref of REFS) {
    const deleteAt = lines.indexOf(`delete-generic-password -s shared-agent-memory -a ${ref}`)
    const readBackAt = lines.lastIndexOf(`find-generic-password -s kinfold -a ${ref} -w`, deleteAt)
    const addAt = w.securityCalls.findIndex((c) => c.stdin?.includes(`-s kinfold -a ${ref} -w`) === true)
    expect(deleteAt).toBeGreaterThan(-1)
    expect(addAt).toBeGreaterThan(-1)
    expect(readBackAt).toBeGreaterThan(addAt)
    expect(deleteAt).toBeGreaterThan(readBackAt)
  }
  // Copies never replace an entry (no -U), and every delete comes after every copy.
  expect(w.securityCalls.filter((c) => c.stdin?.includes('-s kinfold') === true).every((c) => !c.stdin!.includes(' -U '))).toBe(true)

  expect(existsSync(paths.legacyLaunchAgentPlist)).toBe(false)
  expect(w.launchd.legacyLoaded).toBe(false)
  const launchctl = w.commands.filter((c) => c.argv[0] === LAUNCHCTL).map((c) => c.argv.slice(1, 3).join(' '))
  expect(launchctl.indexOf(`bootout gui/${UID}/${LEGACY_LAUNCH_AGENT_LABEL}`)).toBeLessThan(launchctl.indexOf(`bootstrap gui/${UID}`))
  const claude = w.commands.filter((c) => c.argv[0] === 'claude' && c.argv[1] === 'mcp').map((c) => c.argv.slice(2, 6).join(' '))
  expect(claude).toEqual([`remove --scope user ${LEGACY_MCP_SERVER_NAME}`, `add-json --scope user ${MCP_SERVER_NAME}`])
  const opencode = JSON.parse(readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8'))
  expect(Object.keys(opencode.mcp)).toEqual([MCP_SERVER_NAME])
  expect(opencode.theme).toBe('dark')
  expect(existsSync(paths.legacyOpencodePlugin)).toBe(false)
  expect(readFileSync(paths.opencodePlugin, 'utf8')).toStartWith('// kinfold: ')
  expectNoValueLeaked(w)
})

test('a kinfold entry with a different value stops the migration and deletes nothing', async () => {
  const w = legacyWorld()
  w.keychain.add('db-key')
  w.keychainValues.set('db-key', newDbKey())
  const opencodeBefore = readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toContain('db-key')
  expect(w.out.at(-1)).toContain('different value')
  expectLegacyUntouched(w, opencodeBefore)
  expect(w.keychainValues.get('db-key')).not.toBe(VALUES['db-key'])
  expectNoValueLeaked(w)
})

test('an existing ~/.kinfold beside the legacy dir stops the migration', async () => {
  const w = legacyWorld()
  mkdirSync(w.dataDir)
  const before = snapshotTree(w.home)
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toContain(`both ${installPaths(w.env).legacyDataDir} and ${w.dataDir} exist`)
  expect(snapshotTree(w.home)).toEqual(before)
  expect(adds(w)).toBe(0)
  expect(deletes(w)).toEqual([])
})

test('a rename that fails leaves everything in place', async () => {
  const w = legacyWorld()
  w.env.renameDir = () => {
    throw Object.assign(new Error('EXDEV: cross-device link not permitted, rename'), { code: 'EXDEV' })
  }
  const opencodeBefore = readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toContain('EXDEV')
  expectLegacyUntouched(w, opencodeBefore)
  expect(w.commands.some((c) => c.argv[0] === 'claude' && c.argv[2] === 'remove')).toBe(false)
  expectNoValueLeaked(w)
})

test('a daemon still answering /health stops the migration before anything changes', async () => {
  const w = legacyWorld()
  // The LaunchAgent is loaded, but the daemon answering is a hand-started one that bootout does not stop.
  w.launchd.legacyLoaded = true
  extraDaemons.push(startWorldDaemon(w, installPaths(w.env).legacyDataDir))
  const opencodeBefore = readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(w.out.at(-1)).toContain('still answers /health')
  expect(w.out.at(-1)).toContain('nothing was moved')
  expect(adds(w)).toBe(0)
  expectLegacyUntouched(w, opencodeBefore)
})

/** The fake `claude` answers but never edits ~/.claude.json, as the real one would on `claude mcp remove`. */
function claudeRemovedLegacyEntry(w: FakeWorld): void {
  const path = mcpPaths(w.env).claudeUserConfig
  const config = JSON.parse(readFileSync(path, 'utf8'))
  delete config.mcpServers[LEGACY_MCP_SERVER_NAME]
  writeFileSync(path, JSON.stringify(config))
}

test('a second install after the migration plans no migration actions', async () => {
  const w = legacyWorld({ running: true })
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  claudeRemovedLegacyEntry(w)
  expect(renameMigrationActions(w.env)).toEqual([])
  const callsBefore = w.securityCalls.length
  w.out.length = 0
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(w.out.join('\n')).not.toContain('migration')
  // Only metadata lookups reach the old service now: no value read, no copy, no delete.
  const later = w.securityCalls.slice(callsBefore)
  expect(later.filter((c) => c.args.includes('shared-agent-memory')).every((c) => c.args[0] === 'find-generic-password' && !c.args.includes('-w'))).toBe(true)
  expect(later.some((c) => c.stdin !== undefined)).toBe(false)
})

test('a run after a partial migration finishes the remaining steps', async () => {
  const w = legacyWorld({ running: true })
  const realSecurity = w.env.security
  // The first legacy delete fails: the copies and the move are done, the old entries still there.
  w.env.security = (invocation) => (invocation.args[0] === 'delete-generic-password' ? { exitCode: 1, stdout: '' } : realSecurity(invocation))
  expect(await install(w.env, YES)).toBe(EXIT_FAILED)
  expect(lstatSync(installPaths(w.env).legacyDataDir).isSymbolicLink()).toBe(true)
  expect(w.legacyKeychain.size).toBe(REFS.length)
  for (const ref of REFS) expect(w.keychainValues.get(ref)).toBe(VALUES[ref])

  w.env.security = realSecurity
  const actions = renameMigrationActions(w.env).map((action) => action.kind)
  expect(actions).not.toContain('move-data-dir')
  expect(actions).toContain('remove-legacy-keychain-entry')
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(w.legacyKeychain.size).toBe(0)
  for (const ref of REFS) expect(w.keychainValues.get(ref)).toBe(VALUES[ref])
  expect(existsSync(installPaths(w.env).legacyOpencodePlugin)).toBe(false)
  claudeRemovedLegacyEntry(w)
  expect(renameMigrationActions(w.env)).toEqual([])
  expectNoValueLeaked(w)
})

test('the dry run lists every step and shows no Keychain value', async () => {
  // The agent is loaded but no daemon runs, so every Keychain call below is the installer's own.
  const w = legacyWorld()
  w.launchd.legacyLoaded = true
  const before = snapshotTree(join(w.home, 'Library'))
  const opencodeBefore = readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')
  expect(await install(w.env, { ...YES, dryRun: true })).toBe(EXIT_OK)
  const out = w.out.join('\n')
  const paths = installPaths(w.env)
  for (const part of [
    `bootout gui/${UID}/${LEGACY_LAUNCH_AGENT_LABEL}`,
    'check that no daemon answers /health',
    ...REFS.map((ref) => `copy ${ref} from service shared-agent-memory to kinfold (value <hidden>)`),
    `move ${paths.legacyDataDir} -> ${w.dataDir}`,
    `remove ${paths.legacyLaunchAgentPlist}`,
    ...REFS.map((ref) => `delete-generic-password -s shared-agent-memory -a ${ref}`),
    `claude mcp remove --scope user ${LEGACY_MCP_SERVER_NAME}`,
    `write ${mcpPaths(w.env).opencodeConfig}`,
    `remove ${paths.legacyOpencodePlugin}`,
  ]) expect(out).toContain(part)
  expect(snapshotTree(join(w.home, 'Library'))).toEqual(before)
  expect(readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')).toBe(opencodeBefore)
  expect(w.launchd.legacyLoaded).toBe(true)
  expect(adds(w)).toBe(0)
  expect(deletes(w)).toEqual([])
  expect(w.securityCalls.some((c) => c.args.includes('-w'))).toBe(false)
  expectNoValueLeaked(w)
})

test('a shim is ours under either marker; one without a marker, or not re-exporting the plugin, is not', () => {
  const entry = '/repo/src/plugins/opencode.ts'
  expect(isOwnShim(shimContent(entry))).toBe(true)
  expect(shimContent(entry)).toStartWith('// kinfold: ')
  expect(isOwnShim(legacyShim(entry))).toBe(true)
  expect(isOwnShim(`export { default } from ${JSON.stringify(entry)};\n`)).toBe(false)
  expect(isOwnShim('// shared-agent-memory: but something else\nexport const x = 1\n')).toBe(false)
  expect(isOwnShim(null)).toBe(false)
})

test('a foreign file under the old shim name stays, and the rest still migrates', async () => {
  const w = legacyWorld()
  const paths = installPaths(w.env)
  writeFileSync(paths.legacyOpencodePlugin, 'export const mine = true\n')
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(readFileSync(paths.legacyOpencodePlugin, 'utf8')).toBe('export const mine = true\n')
  expect(w.out).toContain(`migration: ${paths.legacyOpencodePlugin} is not a plugin shim we wrote; left alone`)
  expect(lstatSync(paths.legacyDataDir).isSymbolicLink()).toBe(true)
})

test('removeMcpEntryNamed takes only our entry under that name', () => {
  const target = { bunPath: '/b/bun', serverScript: '/r/src/mcp/server.ts' }
  const config = { mcp: { [LEGACY_MCP_SERVER_NAME]: openCodeMcpEntry(target), [MCP_SERVER_NAME]: openCodeMcpEntry(target) } }
  expect(removeMcpEntryNamed(config, 'opencode', LEGACY_MCP_SERVER_NAME)).toEqual({ config: { mcp: { [MCP_SERVER_NAME]: openCodeMcpEntry(target) } }, removed: true })
  const foreign = { mcp: { [LEGACY_MCP_SERVER_NAME]: { type: 'local', command: ['node', 'x.js'] } } }
  expect(removeMcpEntryNamed(foreign, 'opencode', LEGACY_MCP_SERVER_NAME)).toEqual({ config: foreign, removed: false })
  expect(removeMcpEntryNamed({ mcp: { [LEGACY_MCP_SERVER_NAME]: openCodeMcpEntry(target) } }, 'opencode', LEGACY_MCP_SERVER_NAME)).toEqual({ config: {}, removed: true })
})
