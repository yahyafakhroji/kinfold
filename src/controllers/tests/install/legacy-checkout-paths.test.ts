// A checkout install from before src/ was regrouped wrote absolute paths
// such as <checkout>/src/cli/hook.ts into agent configs, plugin files and
// the service definition. After the move the installer still treats those
// entries as its own: install replaces each with one entry naming the new
// path, uninstall removes it, and neither touches the data folder or keys.

import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CLAUDE_HOOK_EVENTS, samHookGroup } from '../../../resources/install-plan/claude-hooks'
import { entryCommand, isOurEntry } from '../../../resources/install-plan/entry'
import { installPaths } from '../../../resources/install-plan/env'
import { LEGACY_CHECKOUT_PATHS } from '../../../resources/install-plan/legacy-checkout-paths'
import { MCP_SERVER_NAME, openCodeMcpEntry } from '../../../resources/install-plan/mcp-config'
import { mcpPaths, mcpTarget } from '../../../resources/install-plan/mcp-wiring'
import { INSTALL_RECORD_FILE } from '../../../resources/install-plan/setup/record'
import { DB_KEY_REF } from '../../../resources/secrets/credentials'
import { dbKeyStoreOf, newDbKey } from '../../../resources/sqlite/keys'
import { openStore } from '../../../resources/store/db'
import { DB_FILE } from '../../../resources/store/data-dir'
import { EXIT_OK, install } from '../../install/install'
import { shimContent } from '../../install/opencode-shim'
import { StubService } from '../../install/service/stub-service'
import { uninstall } from '../../install/uninstall'
import { BUN, type FakeWorld, YES, countingService, createWorld, recordingKeyStore } from './test-support'
import { posixOnly } from '../../../../test/platform-guards'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

/** The files a checkout holds after the move, so its old paths read as this checkout's. */
function placeCheckout(projectRoot: string): void {
  for (const file of ['src/controllers/cli/hook.ts', 'src/controllers/mcp/server.ts', 'src/controllers/daemon/main.ts', 'src/controllers/cli/kinfold.ts', 'src/plugins/plugins/opencode.ts', 'src/plugins/plugins/kilo.ts']) {
    mkdirSync(dirname(join(projectRoot, file)), { recursive: true })
    writeFileSync(join(projectRoot, file), '')
  }
}

function legacyWorld(options: Parameters<typeof createWorld>[0] = {}): FakeWorld {
  world = createWorld({ claudeVersion: '2.1.310 (Claude Code)', opencodeVersion: 'opencode v2.1.4', keychainRefs: ['openrouter'], ...options })
  placeCheckout(world.projectRoot)
  return world
}

const legacy = (w: FakeWorld, path: string): string => join(w.projectRoot, path)
const legacyHook = (w: FakeWorld) => ({ entry: { command: BUN, args: [legacy(w, LEGACY_CHECKOUT_PATHS.scripts.hook), '--data-dir', w.dataDir] } })
const legacyMcpArgs = (w: FakeWorld): string[] => [legacy(w, LEGACY_CHECKOUT_PATHS.scripts.mcp), '--data-dir', w.dataDir]

/** Old entries for every kind a darwin world installs: Claude hooks, the OpenCode MCP entry and plugin file, and the plist. */
function plantOldEntries(w: FakeWorld): void {
  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  const hooks = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [samHookGroup(event, legacyHook(w))]]))
  writeFileSync(paths.claudeSettings, JSON.stringify({ hooks }))
  const mcp = mcpPaths(w.env)
  mkdirSync(mcp.opencodeDir, { recursive: true })
  writeFileSync(mcp.opencodeConfig, JSON.stringify({ mcp: { [MCP_SERVER_NAME]: { type: 'local', command: [BUN, ...legacyMcpArgs(w)], enabled: true } } }))
  mkdirSync(paths.opencodePluginsDir, { recursive: true })
  writeFileSync(paths.opencodePlugin, shimContent(legacy(w, LEGACY_CHECKOUT_PATHS.pluginFiles[0]!), w.dataDir))
  mkdirSync(dirname(paths.launchAgentPlist), { recursive: true })
  writeFileSync(paths.launchAgentPlist, `<plist><array><string>${BUN}</string><string>${legacy(w, LEGACY_CHECKOUT_PATHS.scripts.daemon)}</string></array></plist>\n`)
}

const OLD_PATHS = [...Object.values(LEGACY_CHECKOUT_PATHS.scripts), ...LEGACY_CHECKOUT_PATHS.pluginFiles]
const namesOldPath = (w: FakeWorld, text: string): boolean => OLD_PATHS.some((path) => text.includes(legacy(w, path)))

posixOnly('POSIX paths')('an install over a checkout entry from before the move leaves one current entry', async () => {
  const w = legacyWorld()
  plantOldEntries(w)
  const paths = installPaths(w.env)
  expect(await install(w.env, YES)).toBe(EXIT_OK)

  // Hook entry: one group per event, naming the new hook.ts.
  const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'))
  for (const event of CLAUDE_HOOK_EVENTS) expect(settings.hooks[event]).toEqual([samHookGroup(event, { entry: entryCommand(w.env.mode, 'hook', w.dataDir) })])
  // MCP entry: the one kinfold server, naming the new server.ts.
  const mcp = JSON.parse(readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')).mcp
  expect(Object.keys(mcp)).toEqual([MCP_SERVER_NAME])
  expect(mcp[MCP_SERVER_NAME]).toEqual(openCodeMcpEntry(mcpTarget(w.env)))
  // Plugin file: the shim loads the new plugin entry.
  expect(readFileSync(paths.opencodePlugin, 'utf8')).toBe(shimContent(join(w.projectRoot, 'src/plugins/plugins/opencode.ts'), w.dataDir))
  // The launchd plist: one file, naming the new main.ts.
  const plist = readFileSync(paths.launchAgentPlist, 'utf8')
  expect(plist).toContain(`<string>${join(w.projectRoot, 'src/controllers/daemon/main.ts')}</string>`)
  for (const text of [readFileSync(paths.claudeSettings, 'utf8'), readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8'), readFileSync(paths.opencodePlugin, 'utf8'), plist]) expect(namesOldPath(w, text)).toBe(false)
})

posixOnly('POSIX paths')('uninstall removes a checkout entry from before the move', async () => {
  const w = legacyWorld()
  plantOldEntries(w)
  const paths = installPaths(w.env)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)

  const settings = JSON.parse(readFileSync(paths.claudeSettings, 'utf8'))
  expect(settings.hooks ?? {}).toEqual({})
  expect(JSON.parse(readFileSync(mcpPaths(w.env).opencodeConfig, 'utf8')).mcp ?? {}).not.toHaveProperty(MCP_SERVER_NAME)
  expect(existsSync(paths.opencodePlugin)).toBe(false)
  expect(existsSync(paths.launchAgentPlist)).toBe(false)
})

test('an entry naming another program\'s src/cli/hook.ts is not ours', async () => {
  const w = legacyWorld()
  // Same suffix, outside the checkout: no Kinfold beside it.
  const other = join(w.root, 'other-program')
  mkdirSync(join(other, 'src', 'cli'), { recursive: true })
  writeFileSync(join(other, 'src', 'cli', 'hook.ts'), '')
  const foreign = { command: BUN, args: [join(other, 'src', 'cli', 'hook.ts'), '--data-dir', w.dataDir] }
  expect(isOurEntry(foreign.command, foreign.args)).toBe(false)
  expect(isOurEntry(BUN, legacyHook(w).entry.args)).toBe(true)

  const paths = installPaths(w.env)
  mkdirSync(paths.claudeDir, { recursive: true })
  writeFileSync(paths.claudeSettings, JSON.stringify({ hooks: { Stop: [samHookGroup('Stop', { entry: foreign })] } }))
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const stop = JSON.parse(readFileSync(paths.claudeSettings, 'utf8')).hooks.Stop
  expect(stop).toContainEqual(samHookGroup('Stop', { entry: foreign }))
  expect(stop).toContainEqual(samHookGroup('Stop', { entry: entryCommand(w.env.mode, 'hook', w.dataDir) }))

  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(JSON.parse(readFileSync(paths.claudeSettings, 'utf8')).hooks.Stop).toEqual([samHookGroup('Stop', { entry: foreign })])
})

test('the cleanup leaves the data folder and the key store alone', async () => {
  // A service that is set up nowhere: no daemon opens the store while install and uninstall run.
  const w = legacyWorld({ platform: 'linux', opencodeVersion: undefined, keychainRefs: [] })
  const writes: string[] = []
  const keyStore = recordingKeyStore()
  const set = keyStore.set.bind(keyStore)
  const create = keyStore.create.bind(keyStore)
  const del = keyStore.delete.bind(keyStore)
  keyStore.values.set(DB_KEY_REF, newDbKey())
  w.env = { ...w.env, keyStore, service: countingService(new StubService(w.env, 'test service')) }

  // A store with rows, encrypted under the key the key store holds.
  const store = openStore(w.dataDir, { keys: dbKeyStoreOf(keyStore) })
  store.db.run('CREATE TABLE seed (text TEXT)')
  store.db.run("INSERT INTO seed VALUES ('kept'), ('also kept')")
  store.db.close()
  // install.json as a first install writes it, then the spool and a log.
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  const spool = join(w.dataDir, 'spool', 'pending-1.json')
  mkdirSync(dirname(spool), { recursive: true })
  writeFileSync(spool, '{"event":"seed"}\n')
  const log = join(w.dataDir, 'logs', 'daemon.log')
  mkdirSync(dirname(log), { recursive: true })
  writeFileSync(log, 'a log line\n')
  const files = [join(w.dataDir, DB_FILE), join(w.dataDir, INSTALL_RECORD_FILE), spool, log]
  const before = files.map((file) => readFileSync(file))
  const keysBefore = new Map(keyStore.values)

  keyStore.set = (account, value) => (writes.push(`set ${account}`), set(account, value))
  keyStore.create = (account, value) => (writes.push(`create ${account}`), create(account, value))
  keyStore.delete = (account) => (writes.push(`delete ${account}`), del(account))

  // Old checkout entries in the agent config, then install over them and uninstall.
  const paths = installPaths(w.env)
  const hooks = Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [samHookGroup(event, legacyHook(w))]]))
  writeFileSync(paths.claudeSettings, JSON.stringify({ hooks }))
  expect(await install(w.env, YES)).toBe(EXIT_OK)
  expect(namesOldPath(w, readFileSync(paths.claudeSettings, 'utf8'))).toBe(false)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)

  expect(files.map((file) => readFileSync(file).equals(before[files.indexOf(file)]!))).toEqual(files.map(() => true))
  expect(writes.filter((write) => write.startsWith('delete') || keysBefore.has(write.split(' ')[1]!))).toEqual([])
  expect(keyStore.values).toEqual(keysBefore)
})
