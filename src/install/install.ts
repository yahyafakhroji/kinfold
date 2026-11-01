// `kinfold install`: detect the hosts, choose and check each observer, then build
// one plan (data dir modes, the HMAC key migration (P1-J), the pinned
// sqlite-vec build (P2-A), keychain, Claude Code hooks, the OpenCode shim,
// the LaunchAgent, settings through the daemon)
// and print or apply it. A daemon
// that answers /health but was not started by our LaunchAgent stops the
// install before anything changes, so there are never two writers; under
// --takeover the install waits for the user to stop it and never kills it.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deprecationLines, envName, legacyName, readEnv } from '../env-names'
import { LEGACY_LAUNCH_AGENT_LABEL } from '../names'
import { DAEMON_INFO_FILE, DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import { mergeSamHooks } from './claude-hooks'
import { type Health, checkHealth, readDaemonInfo } from './daemon-client'
import { dbKeyActions } from './db-encryption'
import { type HostDetection, type InstallHost, detectHosts, selectedHosts } from './detect'
import { duplicateWarning, findDuplicateWiring } from './duplicates'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { describeTextChange, plannedBackup, readJsonObject, readTextOrNull, serializeJson } from './files'
import { bootoutArgv, bootstrapArgv, isAgentLoaded, legacyPrintArgv, plistContent } from './launch-agent'
import { ChoiceError, type ChoiceOptions, type ObserverChoice, chooseObservers, describeInput } from './observer-choice'
import { hmacMigrationActions } from './hmac-migration'
import { hostHookInstallActions, hostVersionActions } from './host-wiring'
import { claudeMcpInstallActions, claudeMcpState, opencodeMcpInstallActions } from './mcp-wiring'
import { inspectShim, shimContent } from './opencode-shim'
import { scanDataDirModes } from './permissions'
import { type Action, runPlan, stopCommand } from './plan'
import { legacyClaudeMcpRemoval, legacyShimRemoval, migrationFailureNote, renameMigrationActions } from './rename-migration'
import { sqlite3mcInstallActions } from './sqlite3mc-install'
import { vec0InstallActions } from './vec0-install'

export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2
/** Another daemon owns the port. */
export const EXIT_BLOCKED = 3

const DIR_MODE = 0o755
const FILE_MODE = 0o644

export interface InstallOptions extends ChoiceOptions {
  hosts: readonly InstallHost[] | null
  takeover: boolean
}

export interface DaemonSituation {
  health: Health
  loaded: boolean
  pid: number | null
  port: number
  /** The pre-rename LaunchAgent is loaded (and ours is not); the migration stops it. */
  legacyLoaded: boolean
  /** Up, but not ours: neither our LaunchAgent nor the pre-rename one is loaded. */
  foreign: boolean
}

/** Before the rename migration runs, daemon.json is still in the old data dir. */
function daemonInfoDir(env: InstallEnv): string {
  const legacy = installPaths(env).legacyDataDir
  return !existsSync(join(env.dataDir, DAEMON_INFO_FILE)) && existsSync(join(legacy, DAEMON_INFO_FILE)) ? legacy : env.dataDir
}

export async function daemonSituation(env: InstallEnv): Promise<DaemonSituation> {
  const info = readDaemonInfo(daemonInfoDir(env))
  const health = await checkHealth(env, info.port)
  const loaded = await isAgentLoaded(env)
  // The pre-rename agent's daemon is ours too: the migration stops it, so it is never a second writer.
  const legacyLoaded = !loaded && existsSync(installPaths(env).legacyLaunchAgentPlist) && (await isAgentLoaded(env, legacyPrintArgv(env.uid)))
  return { health, loaded, legacyLoaded, pid: info.pid, port: info.port, foreign: health.up && !loaded && !legacyLoaded }
}

export function foreignDaemonMessage(situation: DaemonSituation): string[] {
  const pid = situation.pid !== null ? ` (pid ${situation.pid} from daemon.json)` : ''
  return [
    `a daemon not started by the LaunchAgent already answers on 127.0.0.1:${situation.port}${pid}; kinfold will not start a second one.`,
    `stop it yourself (${stopCommand(situation.pid, situation.port)}) and run install again,`,
    'or pass --takeover to have install wait while you stop it. kinfold never kills it.',
  ]
}

function mkdirIfMissing(path: string, mode: number): Action[] {
  return existsSync(path) ? [] : [{ kind: 'mkdir', path, mode }]
}

function dataDirActions(env: InstallEnv): Action[] {
  const paths = installPaths(env)
  const scan = scanDataDirModes(env.dataDir)
  for (const link of scan.symlinks) env.out(`data dir: symlink ${link} left alone`)
  const touchLog: Action[] = existsSync(paths.logFile) ? [] : [{ kind: 'touch', path: paths.logFile, mode: DATA_FILE_MODE }]
  return [
    ...mkdirIfMissing(env.dataDir, DATA_DIR_MODE),
    ...scan.changes.map((change): Action => ({ kind: 'chmod', dataDir: env.dataDir, change })),
    ...mkdirIfMissing(paths.logsDir, DATA_DIR_MODE),
    ...touchLog,
  ]
}

function credentialActions(choices: readonly ObserverChoice[]): Action[] {
  const seen = new Map<string, string>()
  for (const choice of choices) if (choice.credential !== null) seen.set(choice.credential.ref, choice.credential.value)
  return [...seen].map(([ref, value]): Action => ({ kind: 'keychain-put', ref, value }))
}

function claudeActions(env: InstallEnv): Action[] {
  const paths = installPaths(env)
  const file = readJsonObject(paths.claudeSettings)
  const merge = mergeSamHooks(file.exists ? file.value : {}, { bunPath: env.bunPath, hookScript: paths.hookScript })
  if (!merge.changed) {
    env.out(`claude-code: hooks already wired in ${paths.claudeSettings}`)
    return []
  }
  const backup = plannedBackup(paths.claudeSettings, env.now())
  const parts = [
    merge.added.length > 0 ? `add Kinfold hooks for ${merge.added.join(', ')}` : '',
    merge.replaced.length > 0 ? `replace Kinfold hooks for ${merge.replaced.join(', ')}` : '',
    'every other key and hook kept',
  ].filter((part) => part !== '')
  return [
    ...mkdirIfMissing(paths.claudeDir, DIR_MODE),
    ...(backup !== null ? [{ kind: 'backup', from: paths.claudeSettings, to: backup } as const] : []),
    { kind: 'write', path: paths.claudeSettings, content: serializeJson(merge.settings, file.exists ? file.text : null), mode: file.exists ? file.mode : FILE_MODE, summary: parts.join('; ') },
  ]
}

function opencodeActions(env: InstallEnv): Action[] {
  const paths = installPaths(env)
  const before = readTextOrNull(paths.opencodePlugin)
  const state = inspectShim(before, paths.pluginEntry)
  if (state === 'foreign') throw new Error(`${paths.opencodePlugin} exists and is not a Kinfold plugin shim; move it away first`)
  if (state === 'yes') {
    env.out(`opencode: plugin shim already in ${paths.opencodePlugin}`)
    return []
  }
  const content = shimContent(paths.pluginEntry)
  const summary = `${describeTextChange(before, content) ?? 'unchanged'}${state === 'stale' ? ', replacing a stale plugin path' : ''}`
  return [...mkdirIfMissing(paths.opencodePluginsDir, DIR_MODE), { kind: 'write', path: paths.opencodePlugin, content, mode: FILE_MODE, summary }]
}

/** `restart`: a loaded daemon is reloaded even with an unchanged plist, so it reads a new HMAC master. */
function launchAgentActions(env: InstallEnv, situation: DaemonSituation, takeover: boolean, restart: boolean): Action[] {
  if (env.platform !== 'darwin') {
    env.out('LaunchAgent: macOS only; start the daemon yourself with `bun run daemon`')
    return [{ kind: 'wait-health' }]
  }
  const paths = installPaths(env)
  const content = plistContent(env)
  const change = describeTextChange(readTextOrNull(paths.launchAgentPlist), content)
  const write: Action[] = change === null ? [] : [{ kind: 'write', path: paths.launchAgentPlist, content, mode: FILE_MODE, summary: change }]
  const wait: Action[] = situation.foreign && takeover ? [{ kind: 'wait-takeover', pid: situation.pid, port: situation.port }] : []
  let load: Action[] = []
  if (!situation.loaded) load = [{ kind: 'launchctl', argv: bootstrapArgv(env) }]
  else if (change !== null || restart) load = [{ kind: 'launchctl', argv: bootoutArgv(env.uid) }, { kind: 'launchctl', argv: bootstrapArgv(env) }]
  return [...mkdirIfMissing(paths.launchAgentsDir, DIR_MODE), ...write, ...wait, ...load, { kind: 'wait-health' }]
}

/**
 * Claude Code and OpenCode wiring. Each entry or shim under the pre-rename
 * name goes only after the kinfold one is written (the old opencode.json key
 * inside that same write), and only for the hosts being installed, so a
 * failed step never leaves an agent without a memory server. Reads host
 * config files only, never the data dir or the Keychain.
 */
function agentWiringActions(env: InstallEnv, hosts: readonly InstallHost[]): Action[] {
  const claudeState = hosts.includes('claude-code') ? claudeMcpState(env) : null
  const claudeLegacy = claudeState === 'yes' || claudeState === 'no' || claudeState === 'stale' ? legacyClaudeMcpRemoval(env) : []
  return [
    ...(hosts.includes('claude-code') ? [...claudeActions(env), ...claudeMcpInstallActions(env), ...claudeLegacy] : []),
    ...(hosts.includes('opencode') ? [...opencodeActions(env), ...opencodeMcpInstallActions(env), ...legacyShimRemoval(env)] : []),
  ]
}

function reportDetections(env: InstallEnv, detections: readonly HostDetection[]): void {
  for (const detection of detections) {
    const version = detection.version !== null ? ` ${detection.version}` : ''
    env.out(`host ${detection.host}${version}: ${detection.selected ? 'install' : 'skip'} (${detection.note})`)
  }
}

interface Prepared {
  hosts: InstallHost[]
  detections: HostDetection[]
  situation: DaemonSituation
}

function buildPlan(env: InstallEnv, prepared: Prepared, choices: readonly ObserverChoice[], takeover: boolean): Action[] {
  const { hosts, detections, situation } = prepared
  const hmac = hmacMigrationActions(env)
  const sqlite3mc = sqlite3mcInstallActions(env)
  const vec0 = vec0InstallActions(env, situation.health)
  return [
    ...dataDirActions(env),
    ...hmac.actions,
    ...sqlite3mc.actions,
    ...dbKeyActions(env),
    ...vec0.actions,
    ...hostVersionActions(env, detections),
    ...credentialActions(choices),
    ...agentWiringActions(env, hosts),
    ...(hosts.includes('codex') ? hostHookInstallActions(env, 'codex') : []),
    ...(hosts.includes('cursor') ? hostHookInstallActions(env, 'cursor') : []),
    ...launchAgentActions(env, situation, takeover, hmac.restartDaemon || sqlite3mc.restartDaemon || vec0.restartDaemon),
    ...choices.map((choice): Action => ({ kind: 'settings-put', input: choice.input })),
    ...hmac.cleanup,
  ]
}

function agentState(situation: DaemonSituation): string {
  if (situation.loaded) return 'LaunchAgent loaded'
  if (situation.legacyLoaded) return `LaunchAgent ${LEGACY_LAUNCH_AGENT_LABEL} (the old name) loaded; the migration stops it`
  return 'LaunchAgent not loaded'
}

/**
 * Prints each SAM_* variable the installer itself was started with (names
 * only), and refuses when SAM_DATA_DIR points at the old data dir: the data
 * dir would then be the old one, the move would be skipped, and the new
 * LaunchAgent would keep the old path. Returns the refusal, or null.
 */
function legacyEnvProblem(env: InstallEnv): string | null {
  const vars = env.envVars ?? {}
  for (const line of deprecationLines(vars)) env.out(line)
  const current = vars[envName('DATA_DIR')]
  if (current !== undefined && current !== '') return null
  const legacy = installPaths(env).legacyDataDir
  if (resolve(env.dataDir) !== resolve(legacy)) return null
  const name = readEnv(vars, 'DATA_DIR') !== undefined ? legacyName('DATA_DIR') : 'the data dir'
  return `${name} points at ${legacy}, so the move to the Kinfold data dir would be skipped; unset ${legacyName('DATA_DIR')} and rerun. Nothing was changed`
}

async function prepare(env: InstallEnv, options: InstallOptions): Promise<Prepared | number> {
  const detections = await detectHosts(env, options.hosts)
  reportDetections(env, detections)
  const hosts = selectedHosts(detections)
  if (hosts.length === 0) {
    env.out('no supported host to install into (Claude Code, OpenCode 2.x, Codex or Cursor)')
    return EXIT_FAILED
  }
  for (const line of duplicateWarning(findDuplicateWiring(env.cwd, [installPaths(env).claudeSettings]))) env.out(line)
  const situation = await daemonSituation(env)
  env.out(`daemon: ${situation.health.up ? `answers on port ${situation.port}` : 'not running'}; ${agentState(situation)}`)
  if (situation.foreign && !options.takeover && !options.dryRun) {
    for (const line of foreignDaemonMessage(situation)) env.out(line)
    return EXIT_BLOCKED
  }
  return { hosts, detections, situation }
}

/**
 * The rename migration runs as its own plan before the install plan is built,
 * so every later step plans against the moved data dir and the kinfold
 * Keychain entries (planned before, the HMAC step would mint a new master
 * over the copied one). A dry run therefore lists it and the agent wiring
 * (which reads host config files only), then stops.
 * Returns the situation to plan with, or null when a dry run stopped here.
 */
async function migrate(env: InstallEnv, prepared: Prepared, options: InstallOptions): Promise<Prepared | null> {
  const actions = renameMigrationActions(env, { takeover: options.takeover })
  if (actions.length === 0) return prepared
  env.out('migration: an install under the old name Shared Agent Memory was found; it moves to the Kinfold names first')
  await runPlan(env, actions, options.dryRun, (index) => migrationFailureNote(actions, index))
  if (options.dryRun) {
    // The wiring steps read host config files only, which the migration leaves alone, so this part of the install plan is exact now.
    env.out('then, among the install steps, the agent wiring (old entries go only after the kinfold ones are written):')
    await runPlan(env, agentWiringActions(env, prepared.hosts), true)
    env.out(`the other install steps are planned once the migration has run, against ${env.dataDir}; run kinfold install --dry-run again then to see them`)
    return null
  }
  env.out('migration: done')
  return { ...prepared, situation: await daemonSituation(env) }
}

export async function install(env: InstallEnv, options: InstallOptions): Promise<number> {
  try {
    const envProblem = legacyEnvProblem(env)
    if (envProblem !== null) {
      env.out(`install failed: ${envProblem}`)
      return EXIT_FAILED
    }
    const found = await prepare(env, options)
    if (typeof found === 'number') return found
    const prepared = await migrate(env, found, options)
    if (prepared === null) {
      if (!found.situation.foreign || options.takeover) return EXIT_OK
      for (const line of foreignDaemonMessage(found.situation)) env.out(line)
      env.out('a real install would stop here, before step 1.')
      return EXIT_BLOCKED
    }
    const choices = await chooseObservers(env, prepared.hosts, options)
    for (const choice of choices) {
      env.out(`observer ${choice.input.host}: ${describeInput(choice.input)} (${choice.origin}); ${choice.credentialNote}; check ${choice.check}`)
    }
    await runPlan(env, buildPlan(env, prepared, choices, options.takeover), options.dryRun)
    if (options.dryRun && prepared.situation.foreign && !options.takeover) {
      for (const line of foreignDaemonMessage(prepared.situation)) env.out(line)
      env.out('a real install would stop here, before step 1.')
      return EXIT_BLOCKED
    }
    if (!options.dryRun) env.out('installed. Check it with: bun src/cli/kinfold.ts status')
    return EXIT_OK
  } catch (error: unknown) {
    env.out(`install failed: ${error instanceof ChoiceError ? error.message : errorMessage(error)}`)
    return EXIT_FAILED
  }
}
