// Test scaffolding for the installer: a temp home, data dir and checkout, and
// fakes for every outside effect. claude, opencode and launchctl answer from a
// script; `launchctl bootstrap` starts a real daemon on a free loopback port in
// the temp data dir, and bootout stops it. HTTP may reach only those test
// daemons, never the real one on 37811. The keychain is an in-memory set of
// refs plus the values written through `security -i`; the test daemon reads
// its HMAC master from those values, never from a real Keychain.
// Tests only; nothing in the installer imports it.

import type { TerminalIO } from './prompt/terminal'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { wantedEpochs } from '../daemon/hmac-rotation'
import { DATA_DIR_NAME, LEGACY_KEYCHAIN_SERVICE, LEGACY_LAUNCH_AGENT_LABEL } from '../names'
import { DB_KEY_REF } from '../secrets/credentials'
import { epochAt, previousEpoch } from '../secrets/hmac-keys'
import type { KeyStore } from '../secrets/key-store'
import { credentialProviderOf } from '../secrets/key-store'
import { ITEM_NOT_FOUND_EXIT, type SecurityInvocation, type SecurityRunner, createKeychainStore } from '../secrets/stores/keychain'
import { credentialDbKeyStore } from '../sqlite/keys'
import { libDir, libraryFileName, manifestPath } from '../sqlite/library'
import { SQLITE3MC_ZIP_SHA256 } from '../sqlite/release'
import type { CliObserverRunner } from '../observer/runners/cli-core'
import type { ObserverRunner, ObserverSettings } from '../observer/types'
import type { CommandRequest, CommandResult, InstallEnv } from './env'
import { LAUNCHCTL } from './launch-agent'
import type { ServiceControl } from './service/control'

export interface WorldOptions {
  claudeVersion?: string | null
  opencodeVersion?: string | null
  codexVersion?: string | null
  /** Answers `cursor --version`; `cursor-agent` is never found. */
  cursorVersion?: string | null
  /** Overrides what `<binary> --version` does: a result, or 'throw' for a runner that rejects. */
  versionResults?: Record<string, (CommandResult & { timedOut?: boolean }) | 'throw'>
  /** Builds the CLI login runner for codex-cli and opencode-cli inputs; default answers OK, passes the planted test and lists no models. */
  cliRunner?: (settings: ObserverSettings) => CliObserverRunner
  /** Answers a command before the built-in fakes do; return undefined to fall through. */
  commandOverride?: (argv: readonly string[]) => CommandResult | undefined
  /** What `/usr/bin/which <binary>` prints; anything else is not found. */
  whichPaths?: Record<string, string>
  platform?: NodeJS.Platform
  runner?: (settings: ObserverSettings) => ObserverRunner
  answers?: string[]
  secrets?: string[]
  stdin?: string
  interactive?: boolean
  /** A scripted terminal for wizard tests; default null (no terminal). */
  terminal?: TerminalIO | null
  keychainRefs?: string[]
  /** Refs held under the pre-rename service shared-agent-memory. */
  legacyKeychainRefs?: string[]
  /** A built sqlite3mc already in <dataDir>/lib, so install plans no GitHub download (sqlite3mc-install.test.ts covers that step). Default true. */
  withLibrary?: boolean
}

export interface FakeWorld {
  root: string
  home: string
  dataDir: string
  projectRoot: string
  cwd: string
  env: InstallEnv
  out: string[]
  commands: CommandRequest[]
  securityCalls: SecurityInvocation[]
  keychain: Set<string>
  /** Values stored through `security -i`, by ref. */
  keychainValues: Map<string, string>
  /** Refs and values under the pre-rename service shared-agent-memory (`keychain` and `keychainValues` are the kinfold service). */
  legacyKeychain: Set<string>
  legacyKeychainValues: Map<string, string>
  checks: ObserverSettings[]
  /**
   * busyAfterBootout: how many bootstraps after a bootout get exit 5, as launchd does mid-teardown.
   * legacyLoaded and legacyDaemon: the pre-rename LaunchAgent (dev.shared-agent-memory.daemon), which only print and bootout reach.
   */
  launchd: { loaded: boolean; daemon: RunningDaemon | null; busyAfterBootout: number; busy: number; legacyLoaded: boolean; legacyDaemon: RunningDaemon | null }
  allowedPorts: Set<number>
  /** "METHOD /path" of every HTTP call the installer made, allowed or not. */
  fetches: string[]
  cleanup: () => Promise<void>
}

export const BUN = '/opt/fake/bin/bun'
export const UID = 501

const okRunner: ObserverRunner = { run: async () => ({ text: 'OK', model: 'fake' }) }

const okCliRunner: CliObserverRunner = {
  run: async () => ({ text: 'OK', model: 'fake' }),
  runWithFiles: async () => ({ text: 'OK', model: 'fake' }),
  probe: async () => ({ version: '1.0.0', binaryPath: '/opt/fake/bin/cli' }),
  listModels: async () => [],
}

export interface FakeKeychain {
  refs: Set<string>
  values: Map<string, string>
}

/** Entries are keyed by (service, account): kinfold is the world's own sets, shared-agent-memory the legacy ones. */
export function fakeSecurity(kinfold: FakeKeychain, legacy: FakeKeychain, calls: SecurityInvocation[]): SecurityRunner {
  const store = (service: string | undefined): FakeKeychain => (service === LEGACY_KEYCHAIN_SERVICE ? legacy : kinfold)
  return (invocation) => {
    calls.push(invocation)
    const [verb] = invocation.args
    if (verb === '-i') {
      const line = invocation.stdin ?? ''
      const match = /-a (\S+) -w (\S+)/.exec(line)
      const { refs, values } = store(/-s (\S+)/.exec(line)?.[1])
      // Like the real Keychain: an add without -U leaves an existing entry alone (`security -i` still exits 0).
      if (match?.[1] !== undefined && refs.has(match[1]) && !line.includes(' -U ')) return { exitCode: 0, stdout: '' }
      if (match?.[1] !== undefined) refs.add(match[1])
      if (match?.[1] !== undefined && match[2] !== undefined) values.set(match[1], match[2])
      return { exitCode: 0, stdout: '' }
    }
    const ref = invocation.args[invocation.args.indexOf('-a') + 1] ?? ''
    const { refs, values } = store(invocation.args[invocation.args.indexOf('-s') + 1])
    if (verb === 'delete-generic-password') {
      values.delete(ref)
      return { exitCode: refs.delete(ref) ? 0 : ITEM_NOT_FOUND_EXIT, stdout: '' }
    }
    if (invocation.args.includes('-w')) return { exitCode: refs.has(ref) ? 0 : ITEM_NOT_FOUND_EXIT, stdout: `${values.get(ref) ?? 'stored-test-key'}\n` }
    return { exitCode: refs.has(ref) ? 0 : ITEM_NOT_FOUND_EXIT, stdout: 'attributes only' }
  }
}

/**
 * A daemon on a free loopback port reading the world's Keychain, as the real
 * daemon reads the real one: a db-key the world holds encrypts a new store.
 * The fake bootstrap starts one in the world's data dir; a test can start one
 * by hand (a legacy install's, say) and must stop it itself.
 */
export function startWorldDaemon(world: FakeWorld, dataDir: string): RunningDaemon {
  // The daemon's reads go through the same fake as the installer's writes, or through the injected store.
  const injected = world.env.keyStore
  const keychain = credentialProviderOf(injected ?? createKeychainStore((invocation) => world.env.security(invocation)))
  const dbKeys = injected === undefined || injected === null
    ? credentialDbKeyStore('keychain', keychain, () => world.keychain.has(DB_KEY_REF) || world.legacyKeychain.has(DB_KEY_REF))
    : credentialDbKeyStore(injected.label, keychain, () => injected.exists(DB_KEY_REF))
  const daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {}, keychain, dbKeys })
  world.allowedPorts.add(daemon.port)
  return daemon
}

async function launchctl(world: FakeWorld, argv: readonly string[]): Promise<CommandResult> {
  const verb = argv[1]
  if ((verb === 'print' || verb === 'bootout') && argv[2]?.endsWith(`/${LEGACY_LAUNCH_AGENT_LABEL}`) === true) {
    if (verb === 'print') return { exitCode: world.launchd.legacyLoaded ? 0 : 113, stdout: '' }
    if (!world.launchd.legacyLoaded) return { exitCode: 3, stdout: '' }
    world.launchd.legacyLoaded = false
    await world.launchd.legacyDaemon?.stop()
    world.launchd.legacyDaemon = null
    return { exitCode: 0, stdout: '' }
  }
  if (verb === 'print') return { exitCode: world.launchd.loaded ? 0 : 113, stdout: '' }
  if (verb === 'bootstrap') {
    if (world.launchd.loaded) return { exitCode: 5, stdout: '' }
    if (world.launchd.busy > 0) {
      world.launchd.busy -= 1
      return { exitCode: 5, stdout: '' }
    }
    world.launchd.loaded = true
    world.launchd.daemon = startWorldDaemon(world, world.dataDir)
    return { exitCode: 0, stdout: '' }
  }
  if (verb === 'bootout') {
    if (!world.launchd.loaded) return { exitCode: 3, stdout: '' }
    world.launchd.loaded = false
    world.launchd.busy = world.launchd.busyAfterBootout
    await world.launchd.daemon?.stop()
    world.launchd.daemon = null
    return { exitCode: 0, stdout: '' }
  }
  return { exitCode: 64, stdout: '' }
}

function fakeRun(world: FakeWorld, options: WorldOptions): (request: CommandRequest) => Promise<CommandResult> {
  return async (request) => {
    world.commands.push(request)
    const [binary] = request.argv
    const overridden = options.commandOverride?.(request.argv)
    if (overridden !== undefined) return overridden
    if (binary === LAUNCHCTL) return launchctl(world, request.argv)
    if (binary === '/usr/bin/which') {
      const path = options.whichPaths?.[request.argv[1] ?? '']
      return path === undefined ? { exitCode: 1, stdout: '' } : { exitCode: 0, stdout: `${path}\n` }
    }
    const override = binary === undefined ? undefined : options.versionResults?.[binary]
    if (override === 'throw') throw new Error('spawn failed (test world)')
    if (override !== undefined) return override
    const versions: Record<string, string | null | undefined> = {
      claude: options.claudeVersion, opencode: options.opencodeVersion, codex: options.codexVersion, cursor: options.cursorVersion,
    }
    const version = binary === undefined ? null : versions[binary]
    return version === null || version === undefined ? { exitCode: 127, stdout: '' } : { exitCode: 0, stdout: `${version}\n` }
  }
}

/** Real fetch, but only to the test daemons this world started. */
function guardedFetch(allowed: Set<number>, fetches: string[]): InstallEnv['fetch'] {
  return async (url, init) => {
    const parsed = new URL(url)
    fetches.push(`${init.method ?? 'GET'} ${parsed.pathname}`)
    const port = Number(parsed.port)
    if (!allowed.has(port)) throw new TypeError('connection refused (test world)')
    return fetch(url, init)
  }
}

/** A stand-in build and the manifest naming it, from the pinned source, with the modes kinfold install gives them. */
export function placeBuiltLibrary(dataDir: string, platform: NodeJS.Platform): void {
  const sha256 = createHash('sha256').update('sqlite3mc stand-in').digest('hex')
  const file = libraryFileName(sha256, platform)!
  mkdirSync(libDir(dataDir), { recursive: true, mode: 0o700 })
  writeFileSync(join(libDir(dataDir), file), 'sqlite3mc stand-in', { mode: 0o600 })
  writeFileSync(manifestPath(dataDir), `${JSON.stringify({ file, sha256, sourceSha256: SQLITE3MC_ZIP_SHA256 })}\n`, { mode: 0o600 })
}

/** Where a fake world's clock starts (2026-10-25): install steps run on it, the daemon it starts runs on the real clock. */
export const WORLD_CLOCK_START = 1_792_900_000_000

/**
 * The sub-key epochs hmac.d holds after a fake-world install and a daemon
 * start: install writes the epoch of the world's clock, the daemon's rotation
 * adds what the real clock wants and keeps only those plus the previous month.
 */
export function worldSubKeyEpochs(now: number = Date.now()): number[] {
  const wanted = wantedEpochs(now)
  const keep = new Set([previousEpoch(epochAt(now)), ...wanted])
  return [...new Set([epochAt(WORLD_CLOCK_START), ...wanted])].filter((epoch) => keep.has(epoch)).sort((a, b) => a - b)
}

export function createWorld(options: WorldOptions = {}): FakeWorld {
  const root = mkdtempSync(join(tmpdir(), 'sam-install-'))
  const home = join(root, 'home')
  const cwd = join(root, 'cwd')
  mkdirSync(home)
  mkdirSync(cwd)
  const answers = [...(options.answers ?? [])]
  const secrets = [...(options.secrets ?? [])]
  let clock = WORLD_CLOCK_START
  const world = {
    root, home, cwd, dataDir: join(home, DATA_DIR_NAME), projectRoot: join(root, 'checkout'),
    out: [], commands: [], securityCalls: [], keychain: new Set(options.keychainRefs ?? []), keychainValues: new Map<string, string>(),
    legacyKeychain: new Set(options.legacyKeychainRefs ?? []), legacyKeychainValues: new Map<string, string>(), checks: [],
    launchd: { loaded: false, daemon: null, busyAfterBootout: 0, busy: 0, legacyLoaded: false, legacyDaemon: null }, allowedPorts: new Set<number>(), fetches: [],
  } as unknown as FakeWorld
  world.env = {
    // An arch with no pinned sqlite-vec build: a fake world never plans the real GitHub download (vec0-install.test.ts covers that step).
    homeDir: home, dataDir: world.dataDir, platform: options.platform ?? 'darwin', arch: 'test-arch', projectRoot: world.projectRoot, cwd, uid: UID,
    mode: { kind: 'checkout', bunPath: BUN, projectRoot: world.projectRoot },
    pathEnv: '/opt/fake/bin:relative/bin:/usr/bin', run: fakeRun(world, options), security: fakeSecurity({ refs: world.keychain, values: world.keychainValues }, { refs: world.legacyKeychain, values: world.legacyKeychainValues }, world.securityCalls),
    now: () => (clock += 100), sleep: async () => {}, fetch: guardedFetch(world.allowedPorts, world.fetches), out: (line) => world.out.push(line),
    io: {
      interactive: options.interactive ?? false,
      ask: async () => answers.shift() ?? '',
      askSecret: async () => secrets.shift() ?? '',
      readStdin: async () => options.stdin ?? '',
    },
    terminal: options.terminal ?? null,
    runnerFor: (settings) => (world.checks.push(settings), (options.runner ?? (() => okRunner))(settings)),
    cliRunnerFor: (settings) => (world.checks.push(settings), (options.cliRunner ?? (() => okCliRunner))(settings)),
    applicationsDirs: [join(root, 'Applications')],
    // Never binds a real port: 37811 may be the live daemon's on this machine.
    portFree: async () => true,
  }
  if (options.withLibrary ?? true) placeBuiltLibrary(world.dataDir, world.env.platform)
  world.cleanup = async () => {
    await world.launchd.daemon?.stop()
    await world.launchd.legacyDaemon?.stop()
    rmSync(root, { recursive: true, force: true })
  }
  return world
}

export interface RecordingKeyStore extends KeyStore {
  values: Map<string, string>
  /** Every account any call named, in order. */
  seen: string[]
}

/** An in-memory KeyStore that records each account it is asked about; its texts follow the Keychain's shape with its own label. */
export function recordingKeyStore(options: { kind?: KeyStore['kind']; label?: string; place?: string; notes?: readonly string[] } = {}): RecordingKeyStore {
  const values = new Map<string, string>()
  const seen: string[] = []
  const label = options.label ?? 'test-store'
  const touch = (account: string): void => void seen.push(account)
  return {
    kind: options.kind ?? 'key-file',
    label,
    place: options.place ?? 'the test store',
    notes: options.notes ?? [],
    values,
    seen,
    get: (account) => (touch(account), values.get(account) ?? null),
    exists: (account) => (touch(account), values.has(account)),
    set: (account, value) => {
      touch(account)
      values.set(account, value)
    },
    create: (account, value) => {
      touch(account)
      if (values.has(account)) return false
      values.set(account, value)
      return true
    },
    delete: (account) => (touch(account), values.delete(account)),
    describeSet: (account) => `${label}: set ${account} (<hidden>)`,
    describeDelete: (account) => `${label}: delete ${account}`,
    describeEntry: (account) => `the ${label} entry ${account}`,
  }
}

/** A `security` runner that fails the test if anything calls it. */
export function forbiddenSecurity(): SecurityRunner {
  return () => {
    throw new Error('security was called')
  }
}

export interface TreeEntry {
  mode: number
  mtimeMs: number
  sha: string | null
}

/** Every path under `dir` with mode, mtime and content hash, for "nothing changed" checks. */
export function snapshotTree(dir: string): Record<string, TreeEntry> {
  const entries: Record<string, TreeEntry> = {}
  const visit = (path: string): void => {
    const stat = lstatSync(path)
    const sha = stat.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
    entries[relative(dir, path) || '.'] = { mode: stat.mode & 0o777, mtimeMs: stat.mtimeMs, sha }
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name))
  }
  if (existsSync(dir)) visit(dir)
  return entries
}

export const YES = { yes: true, dryRun: false, skipCheck: false, replaceCredential: false, credentialStdin: false, flags: [], hosts: null, takeover: false } as const

export interface FakeService extends ServiceControl {
  /** Every method called, in order. */
  calls: string[]
}

/** A ServiceControl that records calls and touches nothing; each answer can be set. */
export function fakeService(options: { running?: boolean; configured?: boolean; startError?: Error; stopError?: Error; holders?: string; dataDir?: string; port?: number } = {}): FakeService {
  const calls: string[] = []
  let running = options.running ?? true
  return {
    label: 'FakeService',
    calls,
    isConfigured: () => (calls.push('isConfigured'), options.configured ?? true),
    isRunning: async () => (calls.push('isRunning'), running),
    start: async () => {
      calls.push('start')
      if (options.startError !== undefined) throw options.startError
      running = true
    },
    stop: async () => {
      calls.push('stop')
      running = false
      if (options.stopError !== undefined) throw options.stopError
    },
    configuredDataDir: () => options.dataDir ?? null,
    configuredPort: () => options.port ?? null,
    fileHolders: async () => (calls.push('fileHolders'), options.holders ?? ''),
  }
}
