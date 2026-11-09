import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { newDbKey } from '../sqlite/keys'
import { checkHealth, readDaemonInfo } from './daemon-client'
import { type CommandResult, installPaths } from './env'
import { installedProgramPath } from './entry'
import { EXIT_OK, install } from './install'
import { LAUNCHCTL, bootoutArgv } from './launch-agent'
import type { ServiceControl } from './service/control'
import { LaunchAgentService } from './service/launch-agent-service'
import { parseSha256Sums, programInstallActions, releaseAssetName, releaseSumsUrl, verifyProgram } from './self-install'
import { type FakeWorld, YES, countingService, createWorld, fakeService, snapshotTree, startWorldDaemon } from './test-support'
import { uninstall } from './uninstall'

const HEX = 'a'.repeat(64)
const ASSET = 'kinfold-darwin-arm64'
const GITHUB = 'https://github.com/yahyafakhroji/kinfold/releases/download'

let world: FakeWorld | null = null
afterEach(async () => {
  await world?.cleanup()
  world = null
})

function sha(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function programWorld(options: Parameters<typeof createWorld>[0] = {}): { w: FakeWorld; binPath: string; source: string } {
  const w = createWorld({ claudeVersion: '2.1.310 (Claude Code)', ...options })
  world = w
  const binPath = installedProgramPath(w.dataDir, w.env.platform)
  w.env = { ...w.env, mode: { kind: 'program', binPath } }
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, 'kinfold program v1\n', { mode: 0o755 })
  return { w, binPath, source }
}

/** A non-development release needs a real target, so hand the world this machine's arch. */
function releaseWorld(options: Parameters<typeof createWorld>[0] = {}): { w: FakeWorld; binPath: string; source: string; asset: string } {
  const built = programWorld(options)
  built.w.env = { ...built.w.env, arch: process.arch }
  return { ...built, asset: releaseAssetName(built.w.env.platform, process.arch)! }
}

function useSums(w: FakeWorld, text: string): { file: string } {
  const file = join(w.root, 'SHA256SUMS')
  writeFileSync(file, text)
  w.env.envVars = { KINFOLD_RELEASE_SUMS_URL: pathToFileURL(file).href }
  return { file }
}

function sumsLine(asset: string, hash: string): string {
  return `${hash}  ${asset}\n`
}

const LEGACY_REF = 'hmac-master'
const LEGACY_VALUE = 'd'.repeat(64)
const DB_KEY = newDbKey()

/**
 * A machine with an install under the old name still to migrate: an old store,
 * plist, Keychain entry, config and a running legacy daemon.
 */
function migrationWorld(): { w: FakeWorld; binPath: string; source: string; asset: string } {
  const w = createWorld({ claudeVersion: '2.1.310 (Claude Code)', withLibrary: false, legacyKeychainRefs: [LEGACY_REF, 'db-key'] })
  world = w
  w.legacyKeychainValues.set(LEGACY_REF, LEGACY_VALUE)
  w.legacyKeychainValues.set('db-key', DB_KEY)
  const paths = installPaths(w.env)
  mkdirSync(paths.launchAgentsDir, { recursive: true })
  writeFileSync(paths.legacyLaunchAgentPlist, '<plist/>\n')
  mkdirSync(join(w.home, '.claude'), { recursive: true })
  writeFileSync(join(w.home, '.claude', 'settings.json'), '{"kept":true}\n')
  w.launchd.legacyLoaded = true
  w.launchd.legacyDaemon = startWorldDaemon(w, paths.legacyDataDir)
  const binPath = installedProgramPath(w.dataDir, w.env.platform)
  w.env = { ...w.env, arch: process.arch, mode: { kind: 'program', binPath } }
  const source = join(w.root, 'kinfold-build')
  writeFileSync(source, 'kinfold program v1\n', { mode: 0o755 })
  return { w, binPath, source, asset: releaseAssetName(w.env.platform, process.arch)! }
}

const installOptions = (source: string, releaseVersion?: string) => ({ ...YES, programSource: source, releaseVersion })

test('releaseAssetName names the five release files and nothing else', () => {
  expect(releaseAssetName('darwin', 'arm64')).toBe('kinfold-darwin-arm64')
  expect(releaseAssetName('darwin', 'x64')).toBe('kinfold-darwin-x64')
  expect(releaseAssetName('linux', 'x64')).toBe('kinfold-linux-x64')
  expect(releaseAssetName('linux', 'arm64')).toBe('kinfold-linux-arm64')
  expect(releaseAssetName('win32', 'x64')).toBe('kinfold-windows-x64.exe')
  expect(releaseAssetName('freebsd', 'x64')).toBeNull()
  expect(releaseAssetName('darwin', 'ia32')).toBeNull()
})

test('parseSha256Sums reads hash and plain name pairs and rejects anything else', () => {
  const sums = parseSha256Sums(`${HEX}  kinfold-darwin-arm64\n${'b'.repeat(64)}  kinfold-windows-x64.exe\n`)
  expect([...sums]).toEqual([['kinfold-darwin-arm64', HEX], ['kinfold-windows-x64.exe', 'b'.repeat(64)]])

  for (const bad of [
    `${HEX.slice(1)}  kinfold-darwin-arm64\n`,
    `${HEX.toUpperCase()}  kinfold-darwin-arm64\n`,
    `${HEX} kinfold-darwin-arm64\n`,
    `${HEX}   kinfold-darwin-arm64\n`,
    `${HEX}  lib/kinfold-darwin-arm64\n`,
    `${HEX}  a name with spaces\n`,
    `${HEX}  kinfold-darwin-arm64\n${HEX}  kinfold-darwin-arm64\n`,
    `${HEX}\tkintfold-darwin-arm64\n`,
    'not a checksum file\n',
  ]) {
    expect(() => parseSha256Sums(bad)).toThrow()
  }
})

test('parseSha256Sums accepts CRLF and still rejects a stray carriage return', () => {
  const sums = parseSha256Sums(`${HEX}  kinfold-darwin-arm64\r\n${'b'.repeat(64)}  kinfold-windows-x64.exe\r\n`)
  expect([...sums]).toEqual([['kinfold-darwin-arm64', HEX], ['kinfold-windows-x64.exe', 'b'.repeat(64)]])
  expect(() => parseSha256Sums(`${HEX}  kinfold-darwin-arm64\r\r\n`)).toThrow()
})

test('verifyProgram answers true only for a listed, matching file', async () => {
  const { w } = programWorld()
  const program = join(w.root, 'program')
  writeFileSync(program, 'bytes')
  expect(await verifyProgram(program, ASSET, sumsLine(ASSET, sha('bytes')))).toBe(true)
  expect(await verifyProgram(program, ASSET, sumsLine(ASSET, sha('other')))).toBe(false)
  expect(await verifyProgram(program, ASSET, sumsLine('kinfold-linux-x64', sha('bytes')))).toBe(false)
  expect(await verifyProgram(join(w.root, 'missing'), ASSET, sumsLine(ASSET, sha('bytes')))).toBe(false)
})

test('the release checksum URL is overridden only for a release candidate', () => {
  const override = 'file:///tmp/kinfold-rc-sums'
  expect(releaseSumsUrl({ KINFOLD_RELEASE_SUMS_URL: override }, '0.4.0-rc.1')).toBe(override)
  expect(releaseSumsUrl({ KINFOLD_RELEASE_SUMS_URL: override }, '0.4.0')).toBe(`${GITHUB}/v0.4.0/SHA256SUMS`)
  for (const version of ['0.4.0-rc.1.evil', '0.4.0-rc.', '0.4.0-rc.x', '0.4.0-rc.1+build', '0.4.0-rcx.1']) {
    expect(releaseSumsUrl({ KINFOLD_RELEASE_SUMS_URL: override }, version)).toBe(`${GITHUB}/v${version}/SHA256SUMS`)
  }
  expect(releaseSumsUrl({ KINFOLD_RELEASE_SUMS_URL: override }, '1.0.0-rc.12')).toBe(override)
  expect(releaseSumsUrl({}, '0.4.0-rc.1')).toBe(`${GITHUB}/v0.4.0-rc.1/SHA256SUMS`)
  expect(releaseSumsUrl({}, '0.4.0')).toBe(`${GITHUB}/v0.4.0/SHA256SUMS`)
})

test('a development version copies the program without a checksum and says so', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  expect(readFileSync(binPath, 'utf8')).toBe(readFileSync(source, 'utf8'))
  expect(statSync(binPath).mode & 0o777).toBe(0o755)
  expect(w.out).toContain('program: the release checksum check is skipped for the development version')
  expect(w.out).toContain(`installed. Check it with: ${binPath} status`)
  expect(readdirSync(join(w.dataDir, 'bin')).filter((name) => name.startsWith('.kinfold-tmp-'))).toEqual([])
})

test('an unchanged program plans no copy', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  w.out.length = 0
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  expect(w.out.join('\n')).not.toContain(`install program ${binPath}`)
})

test('a second install never makes the program non-executable', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  w.out.length = 0
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  expect(statSync(binPath).mode & 0o777).toBe(0o755)
  expect(w.out.join('\n')).not.toContain('chmod <dataDir>/bin/kinfold')
})

test('install restores 0755 on a program someone made 0600', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  chmodSync(binPath, 0o600)
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  expect(statSync(binPath).mode & 0o777).toBe(0o755)
})

test('a program whose hash is missing from SHA256SUMS stops before any change', async () => {
  const { w, source } = releaseWorld()
  useSums(w, sumsLine('kinfold-linux-x64', sha('other')))
  const before = snapshotTree(w.home)
  expect(await install(w.env, installOptions(source, '0.4.0-rc.1'))).toBe(1)
  expect(w.out.at(-1)).toBe('install failed: program does not match the release checksums')
  expect(snapshotTree(w.home)).toEqual(before)
})

test('a program whose hash differs from SHA256SUMS stops before any change', async () => {
  const { w, source, asset } = releaseWorld()
  useSums(w, sumsLine(asset, sha('other bytes')))
  const before = snapshotTree(w.home)
  expect(await install(w.env, installOptions(source, '0.4.0-rc.1'))).toBe(1)
  expect(w.out.at(-1)).toBe('install failed: program does not match the release checksums')
  expect(snapshotTree(w.home)).toEqual(before)
})

test('a failed SHA256SUMS fetch stops the install unchecked', async () => {
  const { w, source } = releaseWorld()
  w.env.envVars = { KINFOLD_RELEASE_SUMS_URL: 'https://127.0.0.1:1/SHA256SUMS' }
  const before = snapshotTree(w.home)
  expect(await install(w.env, installOptions(source, '0.4.0-rc.1'))).toBe(1)
  expect(w.out.at(-1)).toContain('install failed: could not download SHA256SUMS')
  expect(snapshotTree(w.home)).toEqual(before)
})

test('a bad SHA256SUMS stops before a pending migration touches the store, keys, configs or service', async () => {
  const { w, source, asset } = migrationWorld()
  useSums(w, sumsLine(asset, sha('other bytes')))
  const paths = installPaths(w.env)
  const legacyPort = readDaemonInfo(paths.legacyDataDir).port
  const settings = join(w.home, '.claude', 'settings.json')
  const settingsBefore = readFileSync(settings, 'utf8')
  const securityCalls = w.securityCalls.length
  expect(await install(w.env, installOptions(source, '0.4.0-rc.1'))).toBe(1)
  expect(w.out.at(-1)).toBe('install failed: program does not match the release checksums')
  // The data folder was not moved, the config not rewritten, the keys not copied.
  expect(lstatSync(paths.legacyDataDir).isDirectory()).toBe(true)
  expect(existsSync(w.dataDir)).toBe(false)
  expect(readFileSync(settings, 'utf8')).toBe(settingsBefore)
  expect(w.securityCalls.length).toBe(securityCalls)
  expect(w.legacyKeychain.has(LEGACY_REF)).toBe(true)
  expect(w.legacyKeychainValues.get(LEGACY_REF)).toBe(LEGACY_VALUE)
  // The service is still the old one, loaded and answering.
  expect(w.launchd.legacyLoaded).toBe(true)
  expect((await checkHealth(w.env, legacyPort)).up).toBe(true)
  expect(w.commands.filter((call) => call.argv[1] === 'bootout')).toEqual([])
})

test('a dry run with a pending migration lists the program copy and fetches no sums', async () => {
  const { w, binPath, source } = migrationWorld()
  // A URL that cannot be read: the dry run must not touch it.
  w.env.envVars = { KINFOLD_RELEASE_SUMS_URL: pathToFileURL(join(w.root, 'absent-SHA256SUMS')).href }
  const paths = installPaths(w.env)
  const settings = join(w.home, '.claude', 'settings.json')
  const settingsBefore = readFileSync(settings, 'utf8')
  expect(await install(w.env, { ...installOptions(source, '0.4.0-rc.1'), dryRun: true })).toBe(EXIT_OK)
  expect(lstatSync(paths.legacyDataDir).isDirectory()).toBe(true)
  expect(existsSync(w.dataDir)).toBe(false)
  expect(readFileSync(settings, 'utf8')).toBe(settingsBefore)
  expect(w.out.join('\n')).toContain(`install program ${binPath}`)
  expect(w.fetches.every((call) => call === 'GET /health')).toBe(true)
})

test('a dry run lists install program without writing or fetching the sums', async () => {
  const { w, binPath, source } = releaseWorld()
  // A URL that cannot be read: the dry run must not touch it.
  w.env.envVars = { KINFOLD_RELEASE_SUMS_URL: pathToFileURL(join(w.root, 'absent-SHA256SUMS')).href }
  const before = snapshotTree(w.home)
  expect(await install(w.env, { ...installOptions(source, '0.4.0-rc.1'), dryRun: true })).toBe(EXIT_OK)
  expect(snapshotTree(w.home)).toEqual(before)
  expect(w.out.join('\n')).toContain(`install program ${binPath}`)
  expect(w.fetches).toEqual(['GET /health'])
})

test('a copy that fails before the rename leaves the old program in place', async () => {
  const { w, binPath, source } = programWorld()
  mkdirSync(join(w.dataDir, 'bin'), { recursive: true, mode: 0o755 })
  writeFileSync(binPath, 'old program\n', { mode: 0o755 })
  const out = w.env.out
  // The source disappears after the plan was built, before its copy runs.
  w.env.out = (line) => {
    out(line)
    if (line.startsWith('applying ')) rmSync(source)
  }
  expect(await install(w.env, installOptions(source))).toBe(1)
  expect(readFileSync(binPath, 'utf8')).toBe('old program\n')
  expect(readdirSync(join(w.dataDir, 'bin')).filter((name) => name.startsWith('.kinfold-tmp-'))).toEqual([])
})

test('a failed copy starts the daemon again from the program still in place', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  writeFileSync(source, 'kinfold program v2\n')
  w.commands.length = 0
  w.out.length = 0
  const out = w.env.out
  w.env.out = (line) => {
    out(line)
    if (line.startsWith('applying ')) rmSync(source)
  }
  expect(await install(w.env, installOptions(source))).toBe(1)
  expect(readFileSync(binPath, 'utf8')).toBe('kinfold program v1\n')
  const verbs = w.commands.filter((call) => call.argv[0] === LAUNCHCTL).map((call) => call.argv[1])
  expect(verbs).toContain('bootout')
  expect(verbs.slice(-2)).toEqual(['print', 'bootstrap'])
  expect(w.launchd.loaded).toBe(true)
  expect((await checkHealth(w.env, readDaemonInfo(w.dataDir).port)).up).toBe(true)
  expect(w.out.join('\n')).toContain('the daemon was started again from the program in place')
})

/** The world's real LaunchAgent, so the plan's stop really stops its daemon, with some members replaced. */
function launchAgentWith(w: FakeWorld, overrides: Partial<ServiceControl>): ServiceControl {
  return { ...countingService(new LaunchAgentService(w.env)), ...overrides }
}

test('a failed start after the plan stopped the service is reported and the step error stands', async () => {
  const { w, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  writeFileSync(source, 'kinfold program v2\n')
  w.out.length = 0
  const out = w.env.out
  w.env.out = (line) => {
    out(line)
    if (line.startsWith('applying ')) rmSync(source)
  }
  w.env.service = launchAgentWith(w, { start: async () => Promise.reject(new Error('boom')) })
  expect(await install(w.env, installOptions(source))).toBe(1)
  const lines = w.out.join('\n')
  expect(lines).toContain('is not running after restarting (boom), so nothing will answer /health')
  expect(lines).toMatch(/install failed: .*(ENOENT|no such file)/i)
})

test('a restart that opens a large store says the daemon may still be starting', async () => {
  const { w, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  writeFileSync(source, 'kinfold program v2\n')
  w.out.length = 0
  const out = w.env.out
  w.env.out = (line) => {
    out(line)
    if (line.startsWith('applying ')) rmSync(source)
  }
  // Stopped by the plan, started again here, then never answering /health, as a daemon busy with a large store.
  const real = new LaunchAgentService(w.env)
  const starts: string[] = []
  w.env.service = launchAgentWith(w, {
    start: async () => void starts.push('start'),
    isRunning: async () => starts.length > 0 || (await real.isRunning()),
  })
  expect(await install(w.env, installOptions(source))).toBe(1)
  const lines = w.out.join('\n')
  expect(starts).toHaveLength(1)
  expect(lines).toContain('the daemon did not answer /health after restarting; it may still be opening a large store. Run kinfold status in a minute')
  expect(lines).not.toContain('is not running after restarting')
})

test('a service left loaded after a slow wait-health is not started again and the message does not contradict the plan error', async () => {
  const { w, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  writeFileSync(source, 'kinfold program v2\n')
  w.out.length = 0
  const service = fakeService({ running: true })
  w.env.service = service
  w.env.fetch = (async () => Promise.reject(new Error('refused'))) as unknown as typeof w.env.fetch
  expect(await install(w.env, installOptions(source))).toBe(1)
  const lines = w.out.join('\n')
  // The plan's own start ran; the restart after the failed wait found the service loaded and left it.
  expect(service.calls.filter((call) => call === 'start')).toHaveLength(1)
  expect(service.calls.lastIndexOf('start')).toBeLessThan(service.calls.lastIndexOf('isRunning'))
  expect(lines).toContain('the daemon did not answer /health within 180 s; it may still be opening a large store')
  expect(lines).toContain('it may still be opening a large store. Run kinfold status in a minute; see')
  expect(lines).not.toContain('is not running after restarting')
})

test('a failed rename removes the temp file it copied', async () => {
  const { w, binPath, source } = programWorld()
  // A directory at the destination makes the rename fail after the copy ran.
  mkdirSync(binPath, { recursive: true })
  expect(await install(w.env, installOptions(source))).toBe(1)
  expect(existsSync(binPath)).toBe(true)
  expect(readdirSync(join(w.dataDir, 'bin')).filter((name) => name.startsWith('.kinfold-tmp-'))).toEqual([])
})

test('a running service is stopped before its program is replaced and started after', async () => {
  const { w, binPath, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  writeFileSync(source, 'kinfold program v2\n')
  w.commands.length = 0
  w.out.length = 0
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  expect(w.commands.filter((call) => call.argv[0] === LAUNCHCTL).map((call) => call.argv[1])).toEqual(['print', 'bootout', 'print', 'bootstrap'])
  const lines = w.out.join('\n')
  const stop = lines.indexOf(`/bin/launchctl bootout gui/501/dev.kinfold.daemon`)
  const copy = lines.indexOf(`install program ${binPath}`)
  const start = lines.indexOf(`/bin/launchctl bootstrap gui/501`)
  expect(stop).toBeGreaterThan(-1)
  expect(copy).toBeGreaterThan(stop)
  expect(start).toBeGreaterThan(copy)
  expect(readFileSync(binPath, 'utf8')).toBe('kinfold program v2\n')
})

test('uninstall removes the program and library folders and keeps the rest of the data folder', async () => {
  const { w, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  expect(existsSync(join(w.dataDir, 'bin'))).toBe(true)
  expect(existsSync(join(w.dataDir, 'lib'))).toBe(true)
  expect(await uninstall(w.env, { dryRun: false, removeCredentials: false })).toBe(EXIT_OK)
  expect(existsSync(join(w.dataDir, 'bin'))).toBe(false)
  expect(existsSync(join(w.dataDir, 'lib'))).toBe(false)
  expect(existsSync(w.dataDir)).toBe(true)
  expect(existsSync(join(w.dataDir, 'logs', 'daemon.log'))).toBe(true)
})

// A release candidate that is not a development build, so the version comparison applies.
const RUNNING = '0.2.0-rc.1'

/** A program world whose installed program answers `--version` with `answer`, and the plan for installing `source` over it. */
async function planOver(answer: CommandResult, version: string = RUNNING): Promise<{ w: FakeWorld; binPath: string; source: string; actions: string[] }> {
  const { w, binPath, source } = programWorld()
  mkdirSync(join(w.dataDir, 'bin'), { recursive: true, mode: 0o700 })
  writeFileSync(binPath, 'installed program\n', { mode: 0o755 })
  const run = w.env.run
  w.env = { ...w.env, run: async (request) => (request.argv[0] === binPath ? (w.commands.push(request), answer) : run(request)) }
  const sourceHash = sha(readFileSync(source))
  const check = { sourceHash, assetName: ASSET, expectedSha256: sourceHash, check: true }
  const plan = await programInstallActions(w.env, { source, dryRun: false, version, check })
  return { w, binPath, source, actions: plan.actions.map((action) => action.kind) }
}

test('an installed program newer than the running one is kept, said in one line', async () => {
  const { w, binPath, actions } = await planOver({ exitCode: 0, stdout: '0.3.0\n' })
  expect(actions).toEqual([])
  expect(w.out).toEqual([`program: ${binPath} is 0.3.0, newer than this one (${RUNNING}); kept it. Run npx kinfold@latest to use the newest`])
  const version = w.commands.filter((c) => c.argv[0] === binPath)
  expect(version.map((c) => c.argv)).toEqual([[binPath, '--version']])
  expect(version[0]?.timeoutMs).toBeGreaterThan(0)
})

test('a development build is told how to replace a newer program', async () => {
  const { w, binPath, actions } = await planOver({ exitCode: 0, stdout: '0.3.0\n' }, '0.0.0-dev')
  expect(actions).toEqual([])
  expect(w.out).toEqual([`program: ${binPath} is 0.3.0, newer than this development build; kept it. Remove ${binPath} first to install this build`])
  expect(w.out.some((line) => line.includes('npx kinfold@latest'))).toBe(false)
})

for (const [name, answer] of [
  ['older', { exitCode: 0, stdout: '0.1.0\n' }],
  ['equal', { exitCode: 0, stdout: `${RUNNING}\n` }],
  ['unreadable', { exitCode: 0, stdout: 'kinfold, some version\n' }],
  ['failed', { exitCode: 1, stdout: '0.3.0\n' }],
  ['timed out', { exitCode: 143, stdout: '0.3.0\n', timedOut: true }],
  ['not found', { exitCode: 127, stdout: '' }],
] as const) {
  test(`an installed program whose version is ${name} is replaced as before`, async () => {
    const { w, actions } = await planOver(answer)
    expect(actions).toEqual(['install-program'])
    expect(w.out.join('\n')).not.toContain('kept it')
  })
}

test('a kept newer program leaves the rest of the install to run, pointed at it', async () => {
  const { w, binPath, source } = programWorld()
  mkdirSync(join(w.dataDir, 'bin'), { recursive: true, mode: 0o700 })
  writeFileSync(binPath, 'installed program\n', { mode: 0o755 })
  const run = w.env.run
  w.env = { ...w.env, run: async (request) => (request.argv[0] === binPath ? { exitCode: 0, stdout: '9.0.0\n' } : run(request)) }
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  expect(readFileSync(binPath, 'utf8')).toBe('installed program\n')
  expect(w.out.join('\n')).toContain('newer than this development build; kept it')
  expect(w.out).toContain(`installed. Check it with: ${binPath} status`)
})

test('replacing the program plans a service stop before the copy', async () => {
  const { w, source } = programWorld()
  expect(await install(w.env, installOptions(source))).toBe(EXIT_OK)
  writeFileSync(source, 'kinfold program v2\n')
  w.out.length = 0
  expect(await install(w.env, { ...installOptions(source), dryRun: true })).toBe(EXIT_OK)
  const plan = w.out.filter((line) => /^ {2}\d+\. /.test(line))
  const stop = plan.findIndex((line) => line.endsWith(bootoutArgv(w.env.uid).join(' ')))
  const copy = plan.findIndex((line) => line.includes('install program '))
  expect(stop).toBeGreaterThanOrEqual(0)
  expect(stop).toBeLessThan(copy)
})
