// `kinfold install`: read the machine as it is, ask the setup questions (or take
// the flags and saved values), then build one plan from the answers (data dir
// modes, the HMAC key migration, the pinned sqlite-vec build, keychain, the
// agents' wiring and unwiring, the LaunchAgent, settings through the daemon,
// install.json) and print or apply it (setup/apply.ts). A daemon
// that answers /health but was not started by our LaunchAgent stops the
// install before anything changes, so there are never two writers; under
// --takeover the install waits for the user to stop it and never kills it.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deprecationLines, envName, legacyName, readEnv } from '../env-names'
import { DEFAULT_PORT } from '../daemon/daemon'
import { LEGACY_LAUNCH_AGENT_LABEL } from '../names'
import type { EmbeddedAssets } from '../runtime/embedded'
import { DAEMON_INFO_FILE, DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import type { ObserverSettingsInput, ObserverSettingsRow } from '../store/observer-settings-store'
import { mergeSamHooks } from './claude-hooks'
import { type Health, checkHealth, getObserverSettings, readDaemonInfo, waitForStart } from './daemon-client'
import { setupDbKeyActions } from './db-encryption'
import { type HostDetection, type InstallHost, detectHosts, selectedHosts } from './detect'
import { duplicateWarning, findDuplicateWiring } from './duplicates'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { entryCommand } from './entry'
import { describeTextChange, plannedBackup, readJsonObject, readTextOrNull, serializeJson } from './files'
import { bootoutArgv, bootstrapArgv, isAgentLoaded, legacyPrintArgv, plistContent } from './launch-agent'
import { ChoiceError, type ChoiceOptions, type ObserverChoice } from './observer-choice'
import { hmacMigrationActions } from './hmac-migration'
import { hostHookInstallActions, hostVersionActions, opencodeInstallActions } from './host-wiring'
import { claudeMcpInstallActions, claudeMcpState, opencodeMcpInstallActions } from './mcp-wiring'
import { scanDataDirModes } from './permissions'
import { serviceOf } from './service/control'
import { type Action, runPlan, stopCommand } from './plan'
import { askHidden, createPrompts, PromptCancelled } from './prompt/prompts'
import { type ProgramCheck, checkProgram, programInstallActions } from './self-install'
import { legacyClaudeMcpRemoval, legacyShimRemoval, migrationFailureNote, renameMigrationActions } from './rename-migration'
import { applySetup } from './setup/apply'
import { type SetupState, readSetupState } from './setup/prefill'
import { installRecordAction, readInstallRecord } from './setup/record'
import { type FolderTarget, type SetupAnswers, type SetupFlags, runWizard } from './setup/wizard'
import { sqlite3mcInstallActions } from './sqlite3mc-install'
import { hostUnwireActions } from './uninstall'
import { vec0InstallActions } from './vec0-install'
import { envForDataDir } from '../cli/kinfold'

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
  /** The running program to place in <dataDir>/bin; the CLI leaves it out so process.execPath is used. */
  programSource?: string
  /** The release version to check against; the CLI leaves it out so src/version.ts decides. */
  releaseVersion?: string
  /** The build's OpenCode plugin bundle; tests inject one because a checkout carries no embedded assets. */
  opencodeAssets?: EmbeddedAssets | null
  /** --data-dir as given; on an installed machine only the installed folder is accepted. */
  dataDirFlag?: string | null
  noEncrypt?: boolean
  port?: number | null
  noUpdateCheck?: boolean
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
  const merge = mergeSamHooks(file.exists ? file.value : {}, { entry: entryCommand(env.mode, 'hook', env.dataDir) })
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

function daemonCommandLine(env: InstallEnv): string {
  const entry = entryCommand(env.mode, 'daemon', env.dataDir)
  return [entry.command, ...entry.args].join(' ')
}

/**
 * `restart`: a loaded daemon is reloaded even with an unchanged plist, so it
 * reads a new HMAC master. An unchanged plist plans no write, but a loaded
 * agent is always checked: launchd reports a crashed job as loaded while
 * nothing answers, and running install again is how a user repairs that. When
 * the daemon is already down at plan time the plan restarts it first, because
 * a bare health wait would only report the failure.
 */
function launchAgentActions(env: InstallEnv, situation: DaemonSituation, takeover: boolean, restart: boolean, port: number): Action[] {
  if (env.platform !== 'darwin') {
    const portEnv = port === DEFAULT_PORT ? '' : `${envName('PORT')}=${port} `
    env.out(`LaunchAgent: macOS only; start the daemon yourself with: ${portEnv}${daemonCommandLine(env)}`)
    return [{ kind: 'wait-health' }]
  }
  const paths = installPaths(env)
  const content = plistContent(env, port)
  const change = describeTextChange(readTextOrNull(paths.launchAgentPlist), content)
  if (change === null && situation.loaded && !restart) {
    if (situation.health.up) {
      env.out('LaunchAgent: loaded with an unchanged plist; checking that the daemon answers')
      return [{ kind: 'wait-health' }]
    }
    env.out('LaunchAgent: loaded with an unchanged plist but the daemon is not answering; restarting it')
    return [{ kind: 'launchctl', argv: bootoutArgv(env.uid) }, { kind: 'launchctl', argv: bootstrapArgv(env) }, { kind: 'wait-health' }]
  }
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
async function agentWiringActions(env: InstallEnv, hosts: readonly InstallHost[], opencodeAssets?: EmbeddedAssets | null): Promise<Action[]> {
  const claudeState = hosts.includes('claude-code') ? claudeMcpState(env) : null
  const claudeLegacy = claudeState === 'yes' || claudeState === 'no' || claudeState === 'stale' ? legacyClaudeMcpRemoval(env) : []
  const opencode = hosts.includes('opencode') ? [...(await opencodeInstallActions(env, opencodeAssets)), ...opencodeMcpInstallActions(env), ...legacyShimRemoval(env)] : []
  return [
    ...(hosts.includes('claude-code') ? [...claudeActions(env), ...claudeMcpInstallActions(env), ...claudeLegacy] : []),
    ...opencode,
  ]
}

/** Each host as found, and whether this install wires it: a host found but not chosen is skipped as not chosen. */
export function reportDetections(env: InstallEnv, detections: readonly HostDetection[], chosen: readonly InstallHost[]): void {
  for (const detection of detections) {
    const version = detection.version !== null ? ` ${detection.version}` : ''
    const wired = chosen.includes(detection.host)
    const note = wired || !detection.selected ? detection.note : 'not chosen'
    env.out(`host ${detection.host}${version}: ${wired ? 'install' : 'skip'} (${note})`)
  }
}

export interface Prepared {
  /** The hosts to wire; every other host wired now is unwired. */
  hosts: readonly InstallHost[]
  /** Found hosts among them, for the host_version record. */
  detections: readonly HostDetection[]
  situation: DaemonSituation
}

function sameSettings(row: ObserverSettingsRow | undefined, input: ObserverSettingsInput): boolean {
  return row !== undefined
    && row.provider === input.provider
    && row.model === input.model
    && row.credentialRef === input.credentialRef
    && row.enabled === input.enabled
}

/**
 * The settings PUTs this plan needs. A running daemon that already holds the
 * same row needs none, so a reinstall changes no settings. A failed safety row
 * still gets a PUT: saving the row is what clears it in the daemon. A probe
 * failure lives in the daemon's memory and only a successful probe clears it,
 * so the PUT does not clear it; it is planned anyway so a reinstall does not
 * hide the failure.
 */
async function settingsActions(env: InstallEnv, choices: readonly ObserverChoice[]): Promise<Action[]> {
  const read = await getObserverSettings(env)
  if (!read.ok) return choices.map((choice): Action => ({ kind: 'settings-put', input: choice.input }))
  const rows = new Map(read.view.rows.map((row) => [row.host, row]))
  const failed = new Set<string>(read.view.safety.filter((row) => row.status === 'failed').map((row) => row.provider))
  for (const probe of read.view.probe) failed.add(probe.provider)
  return choices.flatMap((choice) => {
    if (sameSettings(rows.get(choice.input.host), choice.input) && !failed.has(choice.input.provider)) return []
    return [{ kind: 'settings-put', input: choice.input } as const]
  })
}

export interface InstallPlan {
  actions: Action[]
  /** The plan stops the loaded LaunchAgent to replace the running program. */
  stopsService: boolean
}

/** install.json, written only when what it holds would change; the first install's time is kept. */
function recordActions(env: InstallEnv, state: SetupState, answers: SetupAnswers): Action[] {
  const record = { channel: state.channel, updateCheck: answers.updateCheck, firstInstalledAt: state.firstInstalledAt ?? env.now() }
  const saved = readInstallRecord(env.dataDir)
  const same = saved !== null && saved.channel === record.channel && saved.updateCheck === record.updateCheck && saved.firstInstalledAt === record.firstInstalledAt
  return same ? [] : [installRecordAction(env.dataDir, record)]
}

/**
 * The plan for one answer set. A host wired now but not among the answers is
 * unwired after every kept host is wired, so no step leaves a kept agent
 * without memory. install.json goes last: it records an install that ran.
 */
export async function buildPlan(
  env: InstallEnv,
  prepared: Prepared,
  answers: SetupAnswers,
  state: SetupState,
  options: InstallOptions,
  check: ProgramCheck | null,
): Promise<InstallPlan> {
  const { hosts, detections, situation } = prepared
  const choices = answers.observers
  const dropped = state.wiredHosts.filter((host) => !hosts.includes(host))
  const hmac = hmacMigrationActions(env)
  const sqlite3mc = sqlite3mcInstallActions(env)
  const vec0 = vec0InstallActions(env, situation.health)
  const program = await programInstallActions(env, {
    source: options.programSource ?? process.execPath,
    dryRun: options.dryRun,
    version: options.releaseVersion,
    check: check ?? undefined,
  })
  // The running service starts the program being replaced, so it stops before
  // the copy and the LaunchAgent step below starts it again from the new file.
  const stopped = program.actions.length > 0 && env.platform === 'darwin' && situation.loaded
  const plannedSituation = stopped ? { ...situation, loaded: false } : situation
  return {
    actions: [
      ...dataDirActions(env),
      ...hmac.actions,
      ...sqlite3mc.actions,
      ...setupDbKeyActions(env, answers.encryption),
      ...vec0.actions,
      ...(stopped ? [{ kind: 'launchctl', argv: bootoutArgv(env.uid) } satisfies Action] : []),
      ...program.actions,
      ...hostVersionActions(env, detections),
      ...credentialActions(choices),
      ...(await agentWiringActions(env, hosts, options.opencodeAssets)),
      ...(hosts.includes('codex') ? hostHookInstallActions(env, 'codex') : []),
      ...(hosts.includes('cursor') ? hostHookInstallActions(env, 'cursor') : []),
      ...dropped.flatMap((host) => hostUnwireActions(env, host)),
      ...launchAgentActions(env, plannedSituation, options.takeover, hmac.restartDaemon || sqlite3mc.restartDaemon || vec0.restartDaemon, answers.port),
      ...(await settingsActions(env, choices)),
      ...hmac.cleanup,
      ...recordActions(env, state, answers),
    ],
    stopsService: stopped,
  }
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

async function prepare(env: InstallEnv, options: InstallOptions): Promise<DaemonSituation | number> {
  for (const line of duplicateWarning(findDuplicateWiring(env.cwd, [installPaths(env).claudeSettings]))) env.out(line)
  const situation = await daemonSituation(env)
  env.out(`daemon: ${situation.health.up ? `answers on port ${situation.port}` : 'not running'}; ${agentState(situation)}`)
  if (situation.foreign && !options.takeover && !options.dryRun) {
    for (const line of foreignDaemonMessage(situation)) env.out(line)
    return EXIT_BLOCKED
  }
  return situation
}

/**
 * The rename migration runs as its own plan before the install plan is built,
 * so every later step plans against the moved data dir and the kinfold
 * Keychain entries (planned before, the HMAC step would mint a new master
 * over the copied one). A dry run therefore lists it, the program copy and the
 * agent wiring (which reads host config files only), then stops.
 * Returns the situation to plan with, or null when a dry run stopped here.
 */
async function migrate(env: InstallEnv, situation: DaemonSituation, options: InstallOptions, check: ProgramCheck | null): Promise<{ situation: DaemonSituation; migrated: boolean } | null> {
  const actions = renameMigrationActions(env, { takeover: options.takeover })
  if (actions.length === 0) return { situation, migrated: false }
  env.out('migration: an install under the old name Shared Agent Memory was found; it moves to the Kinfold names first')
  await runPlan(env, actions, options.dryRun, (index) => migrationFailureNote(actions, index))
  if (options.dryRun) {
    // The program copy and the wiring read the running program and host config
    // files only, which the migration leaves alone, so this part is exact now.
    const program = await programInstallActions(env, {
      source: options.programSource ?? process.execPath,
      dryRun: true,
      version: options.releaseVersion,
      check: check ?? undefined,
    })
    env.out(program.actions.length > 0
      ? 'then, among the install steps, the program copy and the agent wiring (old entries go only after the kinfold ones are written):'
      : 'then, among the install steps, the agent wiring (old entries go only after the kinfold ones are written):')
    const hosts = selectedHosts(await detectHosts(env, options.hosts))
    await runPlan(env, [...program.actions, ...(await agentWiringActions(env, hosts, options.opencodeAssets))], true)
    env.out(`the other install steps are planned once the migration has run, against ${env.dataDir}; run kinfold install --dry-run again then to see them`)
    return null
  }
  env.out('migration: done')
  return { situation: await daemonSituation(env), migrated: true }
}

/**
 * A failed step after the plan stopped the LaunchAgent must not leave every
 * host without memory: start the service again from whichever program is in
 * place. A service that is still loaded is running and is left alone. Health,
 * not the bootstrap exit code, decides whether the service came back.
 */
export async function restartService(env: InstallEnv): Promise<void> {
  let started = false
  let startError: unknown = null
  const service = serviceOf(env)
  try {
    if (service !== null && !(await service.isRunning())) {
      await service.start()
      started = true
    }
  } catch (error: unknown) {
    startError = error
  }
  const result = await waitForStart(env, service)
  if (result.ok) {
    if (started) env.out('the daemon was started again from the program in place')
    return
  }
  const reason = startError === null ? '' : ` (${errorMessage(startError)})`
  const logFile = installPaths(env).logFile
  if (result.reason === 'not-running') env.out(`the ${service?.label ?? 'service'} is not running after restarting${reason}, so nothing will answer /health; see ${logFile}`)
  else env.out(`the daemon did not answer /health after restarting${reason}; it may still be opening a large store. Run kinfold status in a minute; see ${logFile}`)
}

function setupFlags(options: InstallOptions): SetupFlags {
  return {
    dataDir: options.dataDirFlag ?? null,
    hosts: options.hosts === null ? null : [...options.hosts],
    observers: options.flags,
    noEncrypt: options.noEncrypt ?? false,
    port: options.port ?? null,
    noUpdateCheck: options.noUpdateCheck ?? false,
    yes: options.yes,
  }
}

/**
 * With a terminal, a key is typed through the same raw session as the
 * questions around it, so two readers never take turns on stdin.
 */
function withTerminalSecrets(env: InstallEnv): InstallEnv {
  const terminal = env.terminal
  if (terminal === null) return env
  return { ...env, io: { ...env.io, askSecret: (question) => askHidden(terminal, question) } }
}

async function folderTarget(env: InstallEnv, dataDir: string): Promise<FolderTarget> {
  const next = envForDataDir(env, dataDir)
  return { env: next, state: await readSetupState(next) }
}

/**
 * A Ctrl-C or a closed stdin during the questions is said once and thrown on
 * as PromptCancelled, so the caller exits 130; nothing has been written by
 * then (only the rename migration of an install under the old name runs
 * before the questions).
 */
export async function install(env: InstallEnv, options: InstallOptions): Promise<number> {
  let migrated = false
  try {
    const envProblem = legacyEnvProblem(env)
    if (envProblem !== null) {
      env.out(`install failed: ${envProblem}`)
      return EXIT_FAILED
    }
    const situation = await prepare(env, options)
    if (typeof situation === 'number') return situation
    // A release build is checked before the migration or any plan can change the
    // machine, so a bad or unreachable SHA256SUMS stops with nothing changed.
    const check = await checkProgram(env, {
      source: options.programSource ?? process.execPath,
      dryRun: options.dryRun,
      version: options.releaseVersion,
    })
    const moved = await migrate(env, situation, options, check)
    if (moved === null) {
      if (!situation.foreign || options.takeover) return EXIT_OK
      for (const line of foreignDaemonMessage(situation)) env.out(line)
      env.out('a real install would stop here, before step 1.')
      return EXIT_BLOCKED
    }
    migrated = moved.migrated
    const asking = withTerminalSecrets(env)
    const state = await readSetupState(asking)
    let target: FolderTarget = { env: asking, state }
    const prompts = env.terminal === null ? null : createPrompts(env.terminal)
    const answers = await runWizard(asking, prompts, state, setupFlags(options), options, async (dataDir) => (target = await folderTarget(asking, dataDir)))
    const planned = target.env === asking ? moved.situation : await daemonSituation(target.env)
    return await applySetup(target.env, target.state, answers, options, { check, situation: planned })
  } catch (error: unknown) {
    if (error instanceof PromptCancelled) {
      env.out(`install cancelled; ${migrated ? 'only the move to the Kinfold names had run' : 'nothing was changed'}`)
      throw error
    }
    env.out(`install failed: ${error instanceof ChoiceError ? error.message : errorMessage(error)}`)
    return EXIT_FAILED
  }
}
