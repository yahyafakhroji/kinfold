import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runHook } from '../cli/hook'
import { T0, seedSession } from '../observer/test-support'
import { seedObservation } from '../context/test-support'
import { DB_KEY_REF } from '../secrets/credentials'
import { recordMismatchMessage } from '../secrets/key-store-record'
import { NO_DB_KEYS } from '../sqlite/keys'
import { maintenancePath } from '../sqlite/open'
import { openStore } from '../store/db'
import { upsertProject } from '../store/writes'
import { stubDiskCheck } from '../install/disk/stub-check'
import { runKeyCommand } from '../install/encrypt'
import { type CommandResult, type InstallEnv, platformOf } from '../install/env'
import { encodeText } from '../install/files'
import { EXIT_FAILED, EXIT_OK, type InstallOptions } from '../install/install'
import { DEVELOPMENT_VERSION } from '../install/self-install'
import { serviceFor } from '../install/service/control'
import { taskXml } from '../install/service/scheduled-task-service'
import { SystemdUserService } from '../install/service/systemd-service'
import { YES, type FakeWorld, createWorld, recordingKeyStore, snapshotTree } from '../install/test-support'
import { NOT_LINKED_LINE, wslInstall, wslStatus, wslUninstall } from './entry'
import { WSL_LINK_FILE, readWslLink, wslHomeDir } from './link'
import { LINKED_SERVICE_LABEL, LINKED_SERVICE_REFUSAL, WslLinkedService } from './linked-service'
import { WSLINFO, WSLPATH } from './windows-install'

const worlds: FakeWorld[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.cleanup()
})

const WIN_APP_DATA = 'C:\\Users\\José\\AppData\\Local'
const WIN_DATA_DIR = 'C:\\Users\\José\\.kinfold'
/** Never the live daemon's 37811; the fake fetch answers it without any socket. */
const PORT = 47_811
const MIRRORED_ADVICE = 'WSL reaches it only with mirrored networking: add networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, run wsl --shutdown, and install again'

interface Stand {
  world: FakeWorld
  env: InstallEnv
  /** The temp folder standing in for /mnt/c. */
  driveC: string
  dataDir: string
  options: InstallOptions
  daemon: 'up' | 'down'
  mode: string
}

/** A linux-WSL world whose interop answers from a temp folder standing in for /mnt/c. */
function stand(options: { daemonJson?: boolean } = {}): Stand {
  const state = { daemon: 'up' as 'up' | 'down', mode: 'mirrored' }
  let driveC = ''
  const paths = (): Record<string, string> => ({ [WIN_APP_DATA]: join(driveC, 'Users', 'José', 'AppData', 'Local'), [WIN_DATA_DIR]: join(driveC, 'Users', 'José', '.kinfold') })
  const answer = (argv: readonly string[]): CommandResult | undefined => {
    const [binary] = argv
    if (binary?.endsWith('powershell.exe') === true) return { exitCode: 0, stdout: `${WIN_APP_DATA}\r\n` }
    if (binary === WSLPATH) {
      const path = paths()[argv[2] ?? '']
      return path === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${path}\n` }
    }
    if (binary === WSLINFO) return { exitCode: 0, stdout: `${state.mode}\n` }
    return undefined
  }
  const world = createWorld({ platform: 'linux', withLibrary: false, claudeVersion: '2.1.0', commandOverride: answer })
  worlds.push(world)
  driveC = join(world.root, 'mnt-c')
  const appData = paths()[WIN_APP_DATA]!
  const dataDir = paths()[WIN_DATA_DIR]!
  mkdirSync(join(appData, 'Kinfold'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  const xml = taskXml({ user: 'PC\\José', program: `${WIN_DATA_DIR}\\bin\\kinfold.exe`, dataDir: WIN_DATA_DIR, port: PORT, logFile: `${WIN_DATA_DIR}\\logs\\daemon.log` })
  writeFileSync(join(appData, 'Kinfold', 'kinfold-daemon.xml'), encodeText(xml, 'utf16le'))
  writeFileSync(join(dataDir, 'install.json'), '{"channel":"powershell","updateCheck":true,"firstInstalledAt":1}\n')
  if (options.daemonJson ?? true) writeFileSync(join(dataDir, 'daemon.json'), `${JSON.stringify({ pid: 4242, port: PORT })}\n`)
  const fetch: InstallEnv['fetch'] = async (url) => {
    world.fetches.push(`GET ${new URL(url).pathname}`)
    if (state.daemon !== 'up' || new URL(url).port !== String(PORT)) throw new TypeError('connection refused (test world)')
    return Response.json({ ok: true, version: '1.2.3', schemaVersion: 7, pid: 4242 })
  }
  const env: InstallEnv = { ...world.env, platform: 'linux', wsl: true, fetch, unflaggedDataDir: world.dataDir, diskCheck: stubDiskCheck('test disk') }
  const programSource = join(world.root, 'kinfold-build')
  writeFileSync(programSource, 'the kinfold program stand-in')
  const installOptions: InstallOptions = { ...YES, hosts: ['claude-code'], programSource, releaseVersion: DEVELOPMENT_VERSION }
  return Object.assign(state, { world, env, driveC, dataDir, options: installOptions })
}

async function linked(): Promise<Stand> {
  const s = stand()
  expect(await wslInstall(s.env, s.options)).toBe(EXIT_OK)
  return s
}

const binPath = (s: Stand): string => join(wslHomeDir(s.world.home), 'bin', 'kinfold')
const claudeSettings = (s: Stand): string => join(s.world.home, '.claude', 'settings.json')

/** A store in the Windows stand-in with ten observations, plaintext. */
function seedWindowsStore(s: Stand): string {
  const store = openStore(s.dataDir, { keys: NO_DB_KEYS })
  upsertProject(store.db, { key: 'p', kind: 'path', displayName: 'p' }, T0)
  const session = seedSession(store, 'claude-code', 's')
  for (let i = 0; i < 10; i++) seedObservation(store, { sessionId: session, projectKey: 'p', host: 'claude-code', title: `note ${i}`, at: T0 + i })
  store.db.close()
  return join(s.dataDir, 'memory.db')
}

/** An env for a key command on the Windows folder, typing back whatever the run asks for. */
function keyCommandEnv(s: Stand, typed: (out: readonly string[]) => string): InstallEnv {
  return { ...s.env, dataDir: s.dataDir, unflaggedDataDir: s.dataDir, io: { ...s.env.io, interactive: true, ask: async () => typed(s.world.out), askSecret: async () => typed(s.world.out) } }
}

const CODE = /([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}/
const lastTwoGroups = (out: readonly string[]): string => {
  const line = [...out].reverse().find((entry) => CODE.test(entry)) ?? ''
  return (CODE.exec(line)?.[0] ?? '').split('-').slice(-2).join('-')
}

test('a linked install wires the WSL agents to the Windows folder', async () => {
  const s = stand()
  const before = snapshotTree(s.driveC)
  expect(await wslInstall(s.env, s.options)).toBe(EXIT_OK)
  const program = binPath(s)
  const settings = JSON.stringify(JSON.parse(readFileSync(claudeSettings(s), 'utf8')))
  expect(settings).toContain(JSON.stringify(program))
  expect(settings).toContain(`${JSON.stringify('--data-dir')},${JSON.stringify(s.dataDir)}`)
  const mcp = s.world.commands.find((request) => request.argv[0] === 'claude' && request.argv.includes('mcp'))
  // The entry travels as JSON, so a Windows path in it has its backslashes escaped.
  expect(mcp?.argv.join(' ')).toContain(JSON.stringify(program))
  expect(mcp?.argv.join(' ')).toContain(JSON.stringify(s.dataDir))
  const linkPath = join(wslHomeDir(s.world.home), WSL_LINK_FILE)
  expect(statSync(linkPath).mode & 0o777).toBe(0o600)
  expect(Object.keys(JSON.parse(readFileSync(linkPath, 'utf8'))).sort()).toEqual(['dataDir', 'linkedAt', 'taskConfig', 'windowsDataDir'])
  expect(readWslLink(wslHomeDir(s.world.home))).toMatchObject({ windowsDataDir: WIN_DATA_DIR, dataDir: s.dataDir })
  expect(readFileSync(program, 'utf8')).toBe('the kinfold program stand-in')
  expect(s.world.out).toContain(`WSL (preview): wired claude-code to the Windows memory at ${WIN_DATA_DIR}`)
  // Nothing under the Windows folder: no key store record, no db key, no mode change, no service.
  expect(snapshotTree(s.driveC)).toEqual(before)
  expect(s.world.securityCalls).toEqual([])
  const steps = s.world.out.filter((line) => /^ {2}\d+\. /.test(line)).join('\n')
  expect(steps).not.toMatch(/chmod|record the key store|db-key|schtasks|systemctl|launchctl/)
  expect(s.world.commands.some((request) => /schtasks|systemctl|launchctl/.test(request.argv[0] ?? ''))).toBe(false)
  // A second run rewrites no link.
  s.world.out.length = 0
  expect(await wslInstall(s.env, s.options)).toBe(EXIT_OK)
  expect(s.world.out.some((line) => line.includes(WSL_LINK_FILE))).toBe(false)
})

test('a linked install with --dry-run writes nothing', async () => {
  const s = stand()
  const home = snapshotTree(s.world.home)
  expect(await wslInstall(s.env, { ...s.options, dryRun: true })).toBe(EXIT_OK)
  expect(snapshotTree(s.world.home)).toEqual(home)
  expect(s.world.out.some((line) => line.includes(WSL_LINK_FILE))).toBe(true)
})

test('NAT networking refuses with the one fix and writes nothing', async () => {
  const s = stand()
  s.daemon = 'down'
  s.mode = 'nat'
  const home = snapshotTree(s.world.home)
  const windows = snapshotTree(s.driveC)
  expect(await wslInstall(s.env, s.options)).toBe(EXIT_FAILED)
  expect(s.world.out.at(-1)).toBe(`WSL (preview): the Windows daemon at 127.0.0.1:${PORT} does not answer from this distro. ${MIRRORED_ADVICE}. Nothing was changed`)
  expect(snapshotTree(s.world.home)).toEqual(home)
  expect(snapshotTree(s.driveC)).toEqual(windows)

  const none = stand({ daemonJson: false })
  const noneHome = snapshotTree(none.world.home)
  expect(await wslInstall(none.env, none.options)).toBe(EXIT_FAILED)
  expect(none.world.out.at(-1)).toBe(`WSL (preview): the Windows install at ${WIN_DATA_DIR} has no running daemon; start Kinfold on Windows and install again. Nothing was changed`)
  expect(snapshotTree(none.world.home)).toEqual(noneHome)
})

test('--data-dir in WSL asks for a separate memory', async () => {
  const s = stand()
  const env: InstallEnv = { ...s.env, dataDir: join(s.world.root, 'linux-memory') }
  expect(await wslInstall(env, { ...s.options, dataDirFlag: env.dataDir })).toBeNull()
  expect(s.world.commands).toEqual([])
  expect(s.world.out).toEqual([])
  // The folder this run would use without the flag is no separate memory.
  expect(await wslInstall({ ...s.env, unflaggedDataDir: s.env.dataDir }, s.options)).toBe(EXIT_OK)
})

test('a linked hook spools into the Windows folder', async () => {
  const s = await linked()
  const input = readFileSync(join(import.meta.dir, '../../test/fixtures/claude-code/post-tool-use.bash.json'), 'utf8')
  const errors: string[] = []
  await runHook(input, s.dataDir, (line) => errors.push(line), { NODE_ENV: 'test', KINFOLD_DB_KEYSTORE: 'none', HOME: s.world.home })
  expect(readdirSync(join(s.dataDir, 'spool')).filter((name) => name.endsWith('.json'))).toHaveLength(1)
})

test('status marks WSL preview', async () => {
  const s = await linked()
  const up = await wslStatus(s.env)
  expect(up?.replaces).toBe(true)
  const lines = up?.lines ?? []
  expect(lines.slice(0, 4)).toEqual([
    `WSL (preview): linked to the Windows memory at ${WIN_DATA_DIR} (${s.dataDir})`,
    'WSL (preview): networking mirrored',
    `daemon /health from WSL: up on 127.0.0.1:${PORT} (1.2.3)`,
    `program: ${binPath(s)}`,
  ])
  expect(lines.some((line) => line.startsWith('  claude-code: detected') && line.includes('wired: yes'))).toBe(true)
  for (const line of lines.slice(0, 3)) expect(line.startsWith('WSL (preview)') || line.startsWith('daemon /health from WSL')).toBe(true)

  s.daemon = 'down'
  s.mode = 'nat'
  const down = await wslStatus(s.env)
  expect(down?.lines.slice(1, 3)).toEqual(['WSL (preview): networking nat', `daemon /health from WSL: not answering; ${MIRRORED_ADVICE}`])

  const plain = stand()
  expect(await wslStatus(plain.env)).toEqual({ lines: [NOT_LINKED_LINE], replaces: false })
  expect(NOT_LINKED_LINE).toBe('WSL (preview): this distro keeps its own memory; it is not linked to a Windows install')
  expect(await wslStatus({ ...plain.env, wsl: false })).toBeNull()
})

test('WSL uninstall never touches the Windows folder', async () => {
  const s = await linked()
  const before = snapshotTree(s.driveC)
  expect(await wslUninstall(s.env, { dryRun: false, removeCredentials: true, removeHmacKeys: true })).toBe(EXIT_OK)
  expect(snapshotTree(s.driveC)).toEqual(before)
  expect(readFileSync(claudeSettings(s), 'utf8')).not.toContain(binPath(s))
  expect(existsSync(wslHomeDir(s.world.home))).toBe(false)
  expect(s.world.out.at(-1)).toBe(`WSL (preview): unwired claude-code; the Windows install at ${WIN_DATA_DIR} is unchanged. Uninstall it from Windows`)
  // Not linked any more: the plain uninstall goes on.
  expect(await wslUninstall(s.env, { dryRun: false, removeCredentials: false })).toBeNull()
})

test('the service of a linked distro is the Windows task, which WSL never drives', async () => {
  const s = await linked()
  const service = serviceFor({ ...s.env, dataDir: s.dataDir })
  expect(service).toBeInstanceOf(WslLinkedService)
  expect(service.label).toBe(LINKED_SERVICE_LABEL)
  expect(service.isConfigured()).toBe(true)
  expect(service.configuredDataDir()).toBe(s.dataDir)
  expect(service.configuredPort()).toBe(PORT)
  expect(service.configPath()).toBeNull()
  expect(service.configContent(PORT)).toBeNull()
  expect(await service.fileHolders('/x')).toBe('')
  expect(service.describe('stop')).toBe(LINKED_SERVICE_REFUSAL)
  await expect(service.start()).rejects.toThrow(LINKED_SERVICE_REFUSAL)
  await expect(service.stop()).rejects.toThrow(LINKED_SERVICE_REFUSAL)
  // A separate Linux memory in the same distro keeps the Linux service; so does a distro with no link.
  expect(serviceFor({ ...s.env, dataDir: join(s.world.root, 'linux-memory') })).toBeInstanceOf(SystemdUserService)
  expect(serviceFor(stand().env)).toBeInstanceOf(SystemdUserService)
})

test('encrypt in a linked distro writes nothing', async () => {
  const s = await linked()
  const path = seedWindowsStore(s)
  const recordPath = join(s.dataDir, 'key-store.json')
  writeFileSync(recordPath, `${JSON.stringify({ store: 'credential-manager', chosenAt: 1 })}\n`)
  const bytes = readFileSync(path)
  const env = keyCommandEnv(s, lastTwoGroups)
  expect(await runKeyCommand(env, 'encrypt')).toBe(EXIT_FAILED)
  expect(s.world.out.at(-1)).toContain(recordMismatchMessage(recordPath, 'credential-manager', platformOf(env)))
  expect(readFileSync(path).equals(bytes)).toBe(true)
  expect(existsSync(maintenancePath(path))).toBe(false)
  expect(s.world.securityCalls).toEqual([])
})

test('encrypt or decrypt of a Windows store whose daemon WSL cannot reach writes nothing', async () => {
  const s = await linked()
  s.daemon = 'down'
  const path = seedWindowsStore(s)
  const bytes = readFileSync(path)
  const store = recordingKeyStore()
  const refusal = `the ${LINKED_SERVICE_LABEL} did not stop (${LINKED_SERVICE_REFUSAL}); it is still running; nothing was changed`
  const env: InstallEnv = { ...keyCommandEnv(s, lastTwoGroups), keyStore: store }
  expect(await runKeyCommand(env, 'encrypt')).toBe(EXIT_FAILED)
  expect(s.world.out.at(-1)).toBe(`kinfold encrypt: ${refusal}`)
  expect(readFileSync(path).equals(bytes)).toBe(true)
  expect(existsSync(maintenancePath(path))).toBe(false)
  expect(store.values.size).toBe(0)

  // An encrypted Windows store is refused the same way, and keeps its key.
  const key = 'a'.repeat(64)
  const encryptedStore = recordingKeyStore()
  encryptedStore.values.set(DB_KEY_REF, key)
  const e = await linked()
  e.daemon = 'down'
  openStore(e.dataDir, { keys: { name: 'test', read: () => key, exists: () => true } }).db.close()
  const encryptedPath = join(e.dataDir, 'memory.db')
  const encryptedBytes = readFileSync(encryptedPath)
  const decryptEnv: InstallEnv = { ...keyCommandEnv(e, () => 'decrypt'), keyStore: encryptedStore }
  expect(await runKeyCommand(decryptEnv, 'decrypt')).toBe(EXIT_FAILED)
  expect(e.world.out.at(-1)).toBe(`kinfold decrypt: ${refusal}`)
  expect(readFileSync(encryptedPath).equals(encryptedBytes)).toBe(true)
  expect(encryptedStore.values.get(DB_KEY_REF)).toBe(key)
})
