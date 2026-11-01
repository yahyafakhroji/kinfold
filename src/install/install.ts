// `sam install`: detect the hosts, choose and check each observer, then build
// one plan (data dir modes, the HMAC key migration (P1-J), the pinned
// sqlite-vec build (P2-A), keychain, Claude Code hooks, the OpenCode shim,
// the LaunchAgent, settings through the daemon)
// and print or apply it. A daemon
// that answers /health but was not started by our LaunchAgent stops the
// install before anything changes, so there are never two writers; under
// --takeover the install waits for the user to stop it and never kills it.

import { existsSync } from 'node:fs'
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import { mergeSamHooks } from './claude-hooks'
import { type Health, checkHealth, readDaemonInfo } from './daemon-client'
import { dbKeyActions } from './db-encryption'
import { type HostDetection, type InstallHost, detectHosts, selectedHosts } from './detect'
import { duplicateWarning, findDuplicateWiring } from './duplicates'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { describeTextChange, plannedBackup, readJsonObject, readTextOrNull, serializeJson } from './files'
import { bootoutArgv, bootstrapArgv, isAgentLoaded, plistContent } from './launch-agent'
import { ChoiceError, type ChoiceOptions, type ObserverChoice, chooseObservers, describeInput } from './observer-choice'
import { hmacMigrationActions } from './hmac-migration'
import { hostHookInstallActions, hostVersionActions } from './host-wiring'
import { claudeMcpInstallActions, opencodeMcpInstallActions } from './mcp-wiring'
import { inspectShim, shimContent } from './opencode-shim'
import { scanDataDirModes } from './permissions'
import { type Action, runPlan, stopCommand } from './plan'
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
  /** Up, but not ours: our LaunchAgent is not loaded. */
  foreign: boolean
}

export async function daemonSituation(env: InstallEnv): Promise<DaemonSituation> {
  const info = readDaemonInfo(env.dataDir)
  const health = await checkHealth(env, info.port)
  const loaded = await isAgentLoaded(env)
  return { health, loaded, pid: info.pid, port: info.port, foreign: health.up && !loaded }
}

export function foreignDaemonMessage(situation: DaemonSituation): string[] {
  const pid = situation.pid !== null ? ` (pid ${situation.pid} from daemon.json)` : ''
  return [
    `a daemon not started by the LaunchAgent already answers on 127.0.0.1:${situation.port}${pid}; sam will not start a second one.`,
    `stop it yourself (${stopCommand(situation.pid, situation.port)}) and run install again,`,
    'or pass --takeover to have install wait while you stop it. sam never kills it.',
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
    merge.added.length > 0 ? `add SAM hooks for ${merge.added.join(', ')}` : '',
    merge.replaced.length > 0 ? `replace SAM hooks for ${merge.replaced.join(', ')}` : '',
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
  if (state === 'foreign') throw new Error(`${paths.opencodePlugin} exists and is not a SAM plugin shim; move it away first`)
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
    ...(hosts.includes('claude-code') ? [...claudeActions(env), ...claudeMcpInstallActions(env)] : []),
    ...(hosts.includes('opencode') ? [...opencodeActions(env), ...opencodeMcpInstallActions(env)] : []),
    ...(hosts.includes('codex') ? hostHookInstallActions(env, 'codex') : []),
    ...(hosts.includes('cursor') ? hostHookInstallActions(env, 'cursor') : []),
    ...launchAgentActions(env, situation, takeover, hmac.restartDaemon || sqlite3mc.restartDaemon || vec0.restartDaemon),
    ...choices.map((choice): Action => ({ kind: 'settings-put', input: choice.input })),
    ...hmac.cleanup,
  ]
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
  env.out(`daemon: ${situation.health.up ? `answers on port ${situation.port}` : 'not running'}; LaunchAgent ${situation.loaded ? 'loaded' : 'not loaded'}`)
  if (situation.foreign && !options.takeover && !options.dryRun) {
    for (const line of foreignDaemonMessage(situation)) env.out(line)
    return EXIT_BLOCKED
  }
  return { hosts, detections, situation }
}

export async function install(env: InstallEnv, options: InstallOptions): Promise<number> {
  try {
    const prepared = await prepare(env, options)
    if (typeof prepared === 'number') return prepared
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
    if (!options.dryRun) env.out('installed. Check it with: bun src/cli/sam.ts status')
    return EXIT_OK
  } catch (error: unknown) {
    env.out(`install failed: ${error instanceof ChoiceError ? error.message : errorMessage(error)}`)
    return EXIT_FAILED
  }
}
