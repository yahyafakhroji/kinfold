// `kinfold update`, run only when the user asks. It downloads the latest
// release's program for this platform next to the installed one, checks it
// against that release's SHA256SUMS, and only then hands over: the new program
// runs `install --yes`, whose own release check, service stop, atomic replace
// and restart are the same steps a fresh install takes. Until that hand-off
// nothing but the temp file exists, and the temp file is removed on every path,
// so a cut-off or tampered download leaves the running program and its
// service as they were. A run killed outright (SIGKILL, a crash, a power loss)
// cannot clean up, so each run first removes the temp files of runs no longer alive.

import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { envName } from '../env-names'
import { writeFileAtomic } from '../fs/atomic'
import { type InstallEnv, platformOf } from '../install/env'
import type { CommandBusy } from '../install/prompt/frame'
import { managedServiceOf, serviceOf } from '../install/service/control'
import { installedProgramPath } from '../install/entry'
import { restartService } from '../install/install'
import { RELEASE_BASE, fetchReleaseSums, fileSha256, parseSha256Sums, releaseAssetName, releaseSumsUrl } from '../install/self-install'
import { applyAgentHomes, currentChannel, readInstallRecord } from '../install/setup/record'
import { VERSION } from '../version'
import { getQuietForMs } from '../install/daemon-client'
import { HIDDEN_WINDOW } from '../install/system'
import { QUIET_MS } from './auto'
import { mergeAutoState } from './auto-state'
import { UpdateCheckError, fetchNewestRelease } from './check'
import { writeInstallRun } from './install-run'
import { isDevVersion } from './release'
import { type UpdateLockDeps, acquireUpdateLock, updateLockHolder } from './lock'
import { MAX_PROGRAM_BYTES, removeStaged, stagedProgram } from './stage'
import { readUpdateState } from './state'

export { MAX_PROGRAM_BYTES }
import { compareVersions, isPatchUpdate, parseVersion } from './version-order'

export const DOWNLOAD_TIMEOUT_MS = 300_000

const EXIT_OK = 0
const EXIT_FAILED = 1
/** Not executable until its hash matches. */
const DOWNLOAD_MODE = 0o600
const VERIFIED_MODE = 0o700
const TEMP_NAME = /^\.kinfold-update-(\d+)(?:\.exe)?$/
const BIN_DIR_MODE = 0o700
const PREFIX = 'kinfold update:'

export function programUrl(version: string, assetName: string): string {
  return `${RELEASE_BASE}/v${version}/${assetName}`
}

export interface UpdateDeps {
  /** Runs the downloaded program and resolves with its exit code; default spawns it with this terminal's output and no stdin. */
  runProgram?: (path: string, argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<number>
  /** The running version; default src/version.ts. */
  version?: string
  /** Default MAX_PROGRAM_BYTES; a test lowers it rather than stream 300 MB. */
  maxProgramBytes?: number
  /** Test seam for the update lock's pid and liveness check. */
  lock?: UpdateLockDeps
  /** How long an automatic run waits for the new program's install; default AUTO_INSTALL_TIMEOUT_MS. */
  installTimeoutMs?: number
  /** How long the daemon has been quiet, or null when it cannot say; default asks the daemon (getQuietForMs). */
  quietForMs?: () => Promise<number | null>
}

/** Failures before the hand-off: each message already says nothing was changed. */
class UpdateStop extends Error {}

/**
 * The same run with its output kept, for a terminal: the new program's
 * `install --yes` prints its whole numbered plan, which would scroll the
 * spinner away. Its lines are shown only when that install fails.
 */
export async function captureProgram(path: string, argv: readonly string[], env: Readonly<Record<string, string>>): Promise<{ code: number; lines: string[] }> {
  const child = Bun.spawn([path, ...argv], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...env } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, lines: `${stdout}\n${stderr}`.split(/\r?\n/).filter((line) => line !== '') }
}

function quietProgram(env: InstallEnv): NonNullable<UpdateDeps['runProgram']> {
  return async (path, argv, childEnv) => {
    const { code, lines } = await captureProgram(path, argv, childEnv)
    if (code !== EXIT_OK) for (const line of lines) env.out(line)
    return code
  }
}

/** How the new program's install is run: quietly behind the spinner on a terminal, else with this process's own output. */
function runnerFor(env: InstallEnv, deps: UpdateDeps): NonNullable<UpdateDeps['runProgram']> {
  return deps.runProgram ?? (env.ui !== undefined ? quietProgram(env) : spawnProgram)
}

async function spawnProgram(path: string, argv: readonly string[], env: Readonly<Record<string, string>>): Promise<number> {
  // No stdin: `install --yes` never asks, and a question it did reach could not hang on a pipe.
  const child = Bun.spawn([path, ...argv], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...env } })
  return child.exited
}

/** The child's environment: this one's, as strings, with the saved channel. */
function childEnv(env: InstallEnv, savedHomes: boolean): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(env.envVars ?? {})) if (typeof value === 'string') vars[key] = value
  const record = readInstallRecord(env.dataDir)
  vars[envName('INSTALL_CHANNEL')] = currentChannel(env, record)
  // The daemon's environment is the service's, not the shell the install ran in: an automatic run puts back the
  // agent homes that install saved, so its own install finds the same agents in the same folders.
  return savedHomes ? applyAgentHomes(vars, record?.agentHomes ?? {}) : vars
}

function binDir(env: InstallEnv): string {
  return dirname(installedProgramPath(env.dataDir, env.platform))
}

function tempPath(env: InstallEnv): string {
  const suffix = platformOf(env).os === 'windows' ? '.exe' : ''
  return join(binDir(env), `.kinfold-update-${process.pid}${suffix}`)
}

/** EPERM means the pid exists under another user, so only ESRCH counts as gone. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

function errorLabel(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'error')
}

/**
 * The temp programs of update runs that are gone, by name. A live run's file is
 * left out, since its install may still be copying from it; this run's own
 * name is left to the exclusive create, which refuses whatever is there. Only
 * files and links count: a folder with that name is not something we wrote.
 * A folder that cannot be read yields nothing, so it never blocks an update.
 */
function deadLeftovers(env: InstallEnv): string[] {
  const dir = binDir(env)
  let names: string[]
  try {
    names = existsSync(dir) ? readdirSync(dir) : []
  } catch {
    return []
  }
  return names.filter((name) => {
    const pid = Number(TEMP_NAME.exec(name)?.[1] ?? Number.NaN)
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || pidAlive(pid)) return false
    try {
      const stat = lstatSync(join(dir, name))
      return stat.isFile() || stat.isSymbolicLink()
    } catch {
      return false
    }
  })
}

/** One that cannot be removed is named and skipped, so a stuck leftover never stops the update. */
function sweepLeftovers(env: InstallEnv): void {
  for (const name of deadLeftovers(env)) {
    const path = join(binDir(env), name)
    try {
      rmSync(path, { force: true })
    } catch (error: unknown) {
      env.out(`${PREFIX} could not remove ${path}, left by an earlier update (${errorLabel(error)}); remove it by hand`)
    }
  }
}

/** Whether this run created the temp file, so cleanup never removes a file someone else put at that name. */
interface TempFile {
  path: string
  created: boolean
}

function removeTemp(temp: TempFile): void {
  if (temp.created) rmSync(temp.path, { force: true })
}

function tooLarge(): UpdateStop {
  return new UpdateStop('the program download is far larger than a release build; nothing was changed')
}

/** Streams the body to `path` and stops at the cap; a longer body is refused, not truncated. */
async function download(env: InstallEnv, url: string, temp: TempFile, cap: number): Promise<void> {
  let response: Response
  try {
    response = await env.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new UpdateStop(`could not download the program (${error instanceof Error ? error.name : 'error'}); nothing was changed`)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new UpdateStop(`the program download answered ${response.status}; nothing was changed`)
  }
  if (Number(response.headers.get('content-length') ?? 0) > cap) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new UpdateStop('the program download was empty; nothing was changed')
  mkdirSync(dirname(temp.path), { recursive: true, mode: BIN_DIR_MODE })
  let fd: number
  try {
    // Exclusive: never follow a file or link already at this name.
    fd = openSync(temp.path, 'wx', DOWNLOAD_MODE)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new UpdateStop(`${temp.path} already exists; remove it and run kinfold update again; nothing was changed`)
  }
  temp.created = true
  try {
    let size = 0
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error: unknown) {
        throw new UpdateStop(`the program download was cut off (${error instanceof Error ? error.name : 'error'}); nothing was changed`)
      }
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > cap) {
        await reader.cancel().catch(() => undefined)
        throw tooLarge()
      }
      writeSync(fd, chunk.value)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function fetchExpectedHash(env: InstallEnv, version: string, assetName: string): Promise<string> {
  let text: string
  try {
    text = await fetchReleaseSums(env, version)
  } catch (error: unknown) {
    throw new UpdateStop((error instanceof Error ? error.message : 'could not download SHA256SUMS').replace('nothing was written', 'nothing was changed'))
  }
  let expected: string | undefined
  try {
    expected = parseSha256Sums(text).get(assetName)
  } catch (error: unknown) {
    throw new UpdateStop((error instanceof Error ? error.message : 'SHA256SUMS is malformed').replace('nothing was written', 'nothing was changed'))
  }
  if (expected === undefined) throw new UpdateStop(`SHA256SUMS has no entry for ${assetName}; nothing was changed`)
  return expected
}

function describeDryRun(env: InstallEnv, running: string, latest: string, assetName: string, temp: string): string[] {
  const binPath = installedProgramPath(env.dataDir, env.platform)
  const channel = currentChannel(env, readInstallRecord(env.dataDir))
  const leftovers = deadLeftovers(env)
  return [
    `kinfold update: ${running} -> ${latest} (dry run; nothing is downloaded or changed)`,
    ...(leftovers.length === 0 ? [] : [`  0. remove what earlier update runs left in ${binDir(env)}: ${leftovers.join(', ')}`]),
    `  1. download ${releaseSumsUrl(env.envVars ?? {}, latest)}`,
    `  2. download ${programUrl(latest, assetName)} to ${temp} (mode 0700, at most ${MAX_PROGRAM_BYTES} bytes)`,
    `  3. check its sha256 against the ${assetName} line of SHA256SUMS; a mismatch stops here with nothing changed`,
    `  4. run ${temp} --data-dir ${env.dataDir} install --yes with ${envName('INSTALL_CHANNEL')}=${channel}:`,
    `     it checks itself against its release, stops the service, replaces ${binPath}, installs its libraries and starts the service again`,
    `  5. remove ${temp}`,
  ]
}

/** 128 + the signal number, as a shell reports it; SIGHUP is a closed terminal. */
const SIGNAL_EXITS: Readonly<Record<'SIGHUP' | 'SIGINT' | 'SIGTERM', number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

/**
 * A Ctrl-C mid-download would skip the finally below; this removes the temp
 * file first. During the hand-off the child gets the same Ctrl-C and decides,
 * so this process only waits for it and cleans up afterwards.
 */
function guardSignals(temp: TempFile, beforeExit: () => void): { handingOff(): void; release(): void } {
  let waiting = false
  const handlers = Object.entries(SIGNAL_EXITS).map(([signal, code]) => {
    const handler = (): void => {
      if (waiting) return
      removeTemp(temp)
      // The update lock goes with the temp file: an exit here skips runUpdate's own release.
      beforeExit()
      process.exit(code)
    }
    process.on(signal, handler)
    return () => process.off(signal, handler)
  })
  return {
    handingOff: () => {
      waiting = true
    },
    release: () => {
      for (const off of handlers) off()
    },
  }
}

/** The old program's hash, so a failed hand-off can say whether it is still the one in place. */
async function hashOrNull(path: string): Promise<string | null> {
  try {
    return await fileSha256(path)
  } catch {
    return null
  }
}

/** The child may have stopped the service before it failed, so say what it is now. */
async function serviceState(env: InstallEnv): Promise<string> {
  const service = serviceOf(env)
  if (service === null || service.unavailableReason() !== null) return 'this platform has no background service'
  try {
    return (await service.isRunning()) ? 'the service is running' : 'the service is stopped; kinfold install starts it again'
  } catch (error: unknown) {
    return `could not tell whether the service is running (${error instanceof Error ? error.name : 'error'})`
  }
}

async function isRunning(env: InstallEnv): Promise<boolean> {
  try {
    return (await serviceOf(env)?.isRunning()) === true
  } catch {
    return false
  }
}

async function handOff(env: InstallEnv, temp: string, running: string, latest: string, run: NonNullable<UpdateDeps['runProgram']>, savedHomes: boolean): Promise<number> {
  const binPath = installedProgramPath(env.dataDir, env.platform)
  const before = await hashOrNull(binPath)
  const wasRunning = await isRunning(env)
  let code: number
  try {
    code = await run(temp, ['--data-dir', env.dataDir, 'install', '--yes'], childEnv(env, savedHomes))
  } catch (error: unknown) {
    env.out(`${PREFIX} could not start the new program (${error instanceof Error ? error.name : 'error'}); ${binPath} is still ${running}`)
    return EXIT_FAILED
  }
  if (code === EXIT_OK) {
    // Behind the spinner the new install's own notes are not shown, and the one that matters is this: nothing restarted a daemon the service does not run.
    if (env.ui !== undefined && !(await isRunning(env))) env.out(`${PREFIX} the service is not running the daemon; restart the daemon if you started it yourself, so it runs ${latest}`)
    env.out(`kinfold updated to ${latest}`)
    return EXIT_OK
  }
  // A child killed by a signal between its service stop and start never runs
  // its own restart. This process outlives it (its signal handlers only wait),
  // and whichever program is in place now was checked, so it starts that one.
  if (wasRunning && !(await isRunning(env))) await restartService(env)
  const unchanged = before !== null && (await hashOrNull(binPath)) === before
  const program = unchanged
    ? `${PREFIX} the new program's install stopped (exit ${code}); ${binPath} is still ${running}`
    : `${PREFIX} the new program's install stopped (exit ${code}) after replacing ${binPath}; run kinfold install to finish`
  env.out(`${program}; ${await serviceState(env)}`)
  return EXIT_FAILED
}

/** How long an automatic run waits, after its download, for agents to go quiet before it gives up until the next daily check. */
export const QUIET_WAIT_CAP_MS = 1_800_000

const minutes = (ms: number): string => {
  const count = Math.max(1, Math.round(ms / 60_000))
  return `${count} minute${count === 1 ? '' : 's'}`
}

/**
 * Waits until the daemon has been quiet for the full spell again; false when
 * agents stay active past the cap. A daemon that does not answer holds
 * nothing up: with it down, no agent is mid-session with it.
 */
async function quietAgain(env: InstallEnv, deps: UpdateDeps): Promise<boolean> {
  const ask = deps.quietForMs ?? (() => getQuietForMs(env))
  const deadline = env.now() + QUIET_WAIT_CAP_MS
  for (;;) {
    const quietFor = await ask()
    if (quietFor === null || quietFor >= QUIET_MS) return true
    const wait = QUIET_MS - quietFor
    if (env.now() + wait > deadline) return false
    env.out(`${PREFIX} an agent was active ${minutes(quietFor)} ago; waiting ${minutes(wait)} before installing`)
    await env.sleep(wait)
  }
}

/** How a run ended: `current` had nothing newer, `skipped` found a release an automatic run does not apply. */
interface Applied {
  code: number
  outcome: 'updated' | 'current' | 'skipped' | 'failed'
  /** The release GitHub named; null when it could not be asked. */
  latest: string | null
}

const failed = (latest: string | null): Applied => ({ code: EXIT_FAILED, outcome: 'failed', latest })

interface StepOptions {
  dryRun: boolean
  patchOnly: boolean
  /** The dashboard's run: install this staged release and nothing else. */
  staged?: string
  onInterrupt?: () => void
}

/** The staged program in place of a download: copied to the temp name, so the bytes checked next are the bytes run. */
function copyStaged(source: string, temp: TempFile): void {
  mkdirSync(dirname(temp.path), { recursive: true, mode: BIN_DIR_MODE })
  try {
    copyFileSync(source, temp.path, constants.COPYFILE_EXCL)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    throw new UpdateStop(`${temp.path} already exists; remove it and run kinfold update again; nothing was changed`)
  }
  temp.created = true
  chmodSync(temp.path, DOWNLOAD_MODE)
}

/** On a terminal the whole update runs under one spinner, which ends on the last line the update said. */
async function applyUpdate(env: InstallEnv, options: StepOptions, deps: UpdateDeps, run: NonNullable<UpdateDeps['runProgram']>): Promise<Applied> {
  const busy = options.dryRun ? undefined : env.ui?.busy('looking for a newer release')
  try {
    const applied = await applyUpdateSteps(env, options, deps, run, busy)
    if (applied.code === EXIT_OK) busy?.done()
    else busy?.fail()
    return applied
  } catch (error: unknown) {
    busy?.fail()
    throw error
  }
}

async function applyUpdateSteps(env: InstallEnv, options: StepOptions, deps: UpdateDeps, run: NonNullable<UpdateDeps['runProgram']>, busy: CommandBusy | undefined): Promise<Applied> {
  // A dry run only lists these (describeDryRun); it removes nothing.
  if (!options.dryRun) sweepLeftovers(env)
  const running = deps.version ?? VERSION
  let latest: string
  try {
    const found = await fetchNewestRelease(env.fetch, env.now, readInstallRecord(env.dataDir)?.beta === true, running)
    // An automatic run applies only a patch, so the beta on offer beside it is left for kinfold update.
    latest = options.patchOnly ? (found.patch ?? found.release.version) : found.release.version
  } catch (error: unknown) {
    env.out(`${PREFIX} could not ask GitHub for the latest release (${error instanceof UpdateCheckError ? error.label : 'error'})`)
    return failed(null)
  }
  if (parseVersion(running) !== null && compareVersions(latest, running) <= 0) {
    env.out(`kinfold is up to date (${running})`)
    return { code: EXIT_OK, outcome: 'current', latest }
  }
  // Asked again here, not taken from the daemon: the release may have changed since its daily check.
  if (options.patchOnly && !isPatchUpdate(running, latest)) {
    env.out(`${PREFIX} ${latest} is not a patch release of ${running}; it is left for kinfold update`)
    return { code: EXIT_OK, outcome: 'skipped', latest }
  }
  // The dashboard offered one release; a newer one since is a new offer, not something to install unseen.
  if (options.staged !== undefined && options.staged !== latest) {
    env.out(`${PREFIX} ${latest} is the release on offer now; reload the dashboard; nothing was changed`)
    return failed(options.staged)
  }
  const arch = env.arch ?? process.arch
  const assetName = releaseAssetName(env.platform, arch)
  if (assetName === null) {
    env.out(`${PREFIX} no release build for ${env.platform}-${arch}`)
    return failed(latest)
  }
  const found = options.dryRun ? null : stagedProgram(env.dataDir, env.platform)
  const staged = found !== null && found.version === latest && found.asset === assetName ? found : null
  if (options.staged !== undefined && staged === null) {
    env.out(`${PREFIX} no checked download of ${latest} is waiting; nothing was changed`)
    return failed(latest)
  }
  const temp: TempFile = { path: tempPath(env), created: false }
  if (options.dryRun) {
    for (const line of describeDryRun(env, running, latest, assetName, temp.path)) env.out(line)
    return { code: EXIT_OK, outcome: 'current', latest }
  }
  const signals = guardSignals(temp, options.onInterrupt ?? (() => undefined))
  try {
    busy?.label(`downloading Kinfold ${latest}`)
    const expected = await fetchExpectedHash(env, latest, assetName)
    if (staged !== null) copyStaged(staged.path, temp)
    else await download(env, programUrl(latest, assetName), temp, deps.maxProgramBytes ?? MAX_PROGRAM_BYTES)
    if ((await fileSha256(temp.path)) !== expected) {
      if (staged === null) throw new UpdateStop('the downloaded program does not match the release checksums; nothing was changed')
      removeStaged(env.dataDir)
      throw new UpdateStop('the staged program does not match the release checksums; it was deleted and nothing was changed')
    }
    chmodSync(temp.path, VERIFIED_MODE)
    // The daemon waited for quiet before it started this run, but the download took time: an agent may have begun since.
    if (options.patchOnly && !(await quietAgain(env, deps))) throw new UpdateStop(`agents were still active ${QUIET_WAIT_CAP_MS / 60_000} minutes after the download; nothing was changed`)
    env.out(`kinfold update: ${latest} downloaded and checked; installing it`)
    busy?.label(`installing Kinfold ${latest}`)
    signals.handingOff()
    const code = await handOff(env, temp.path, running, latest, run, options.patchOnly)
    return code === EXIT_OK ? { code, outcome: 'updated', latest } : failed(latest)
  } catch (error: unknown) {
    // handOff catches its own failures, so anything here came before it: a full
    // disk or a permission error while writing the download.
    const message = error instanceof UpdateStop ? error.message : `could not write the download (${errorLabel(error)}); nothing was changed`
    env.out(`${PREFIX} ${message}`)
    return failed(latest)
  } finally {
    removeTemp(temp)
    signals.release()
  }
}

export const AUTO_UPDATE_LOG = 'auto-update.log'
const LOG_DIR_MODE = 0o700
const LOG_FILE_MODE = 0o600
export const NOT_RUN_BY_SERVICE = 'the daemon is not run by a background service here; run kinfold update'

/** Past this the log is cut back before a run adds to it. A run writes a few kilobytes, so this is years of them. */
export const AUTO_LOG_MAX_BYTES = 262_144
/** What a cut keeps: the newest half, from the start of a line. */
export const AUTO_LOG_KEEP_BYTES = 131_072

/** Keeps the newest AUTO_LOG_KEEP_BYTES of a log that has passed its cap, whole lines only, replaced in one rename. */
function trimAutoLog(path: string): void {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return
  }
  if (size <= AUTO_LOG_MAX_BYTES) return
  const bytes = readFileSync(path)
  const tail = bytes.subarray(bytes.length - AUTO_LOG_KEEP_BYTES)
  const firstLine = tail.indexOf(0x0a) + 1
  writeFileAtomic(path, tail.subarray(firstLine), LOG_FILE_MODE)
}

/** The append-only log of automatic runs, opened once; null when it cannot be opened, which never stops an update. */
function openAutoLog(dataDir: string): number | null {
  try {
    const dir = join(dataDir, 'logs')
    mkdirSync(dir, { recursive: true, mode: LOG_DIR_MODE })
    trimAutoLog(join(dir, AUTO_UPDATE_LOG))
    return openSync(join(dir, AUTO_UPDATE_LOG), 'a', LOG_FILE_MODE)
  } catch {
    return null
  }
}

/** Whether the service runs the daemon: only then does stopping and starting it restart the daemon on the new program. */
async function serviceRunsDaemon(env: InstallEnv): Promise<boolean> {
  const service = managedServiceOf(env)
  try {
    return service !== null && (await service.isRunning())
  } catch {
    return false
  }
}

/** An install that has not finished by now is stuck: with no one watching, the daemon would stay down. */
export const AUTO_INSTALL_TIMEOUT_MS = 900_000
/** What a shell reports for a command it gave up on. */
const EXIT_TIMED_OUT = 124

/**
 * The install an automatic run hands over to, with a deadline. Past it the
 * child is killed and the run reports a failed install, which is what makes
 * handOff start the service again from the program in place.
 */
function boundedInstall(deps: UpdateDeps, output: number | 'ignore'): NonNullable<UpdateDeps['runProgram']> {
  return (path, argv, vars) => {
    let child: ReturnType<typeof Bun.spawn> | null = null
    const run = deps.runProgram ?? ((program, args, env) => {
      // Hidden, like the commands that install then runs: this process has no console for the new program to share.
      child = Bun.spawn([program, ...args], { stdin: 'ignore', stdout: output, stderr: output, env: { ...env }, ...HIDDEN_WINDOW })
      return child.exited
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<number>((resolve) => {
      timer = setTimeout(() => {
        child?.kill()
        resolve(EXIT_TIMED_OUT)
      }, deps.installTimeoutMs ?? AUTO_INSTALL_TIMEOUT_MS)
    })
    return Promise.race([run(path, argv, vars), deadline]).finally(() => clearTimeout(timer))
  }
}

/**
 * The run the daemon starts, with no terminal: every line goes to the log, the
 * new program's install writes there too, and the outcome is saved for the
 * notice, `kinfold status` and the dashboard. Only a patch release is applied.
 */
interface AutoLog {
  logged: InstallEnv
  lines: string[]
  fd: number | null
}

/** An environment whose every line goes to logs/auto-update.log, and is kept for the outcome. */
function autoLog(env: InstallEnv): AutoLog {
  const fd = openAutoLog(env.dataDir)
  const lines: string[] = []
  const out = (line: string): void => {
    lines.push(line)
    if (fd === null) return
    try {
      writeSync(fd, `${new Date(env.now()).toISOString()} ${line}\n`)
    } catch {
      // The outcome is still saved by the caller.
    }
  }
  return { logged: { ...env, out }, lines, fd }
}

async function runAuto(env: InstallEnv, deps: UpdateDeps, onInterrupt: () => void): Promise<number> {
  const { logged, lines, fd } = autoLog(env)
  const out = logged.out
  const running = deps.version ?? VERSION
  const fail = (version: string, reason: string, blocked: boolean = false): number => {
    mergeAutoState(env.dataDir, { failure: { version, at: env.now(), reason, ...(blocked ? { blocked: true as const, running } : {}) } })
    return EXIT_FAILED
  }
  // What the daemon decided to apply; the failure is filed under it until GitHub names the release.
  const seen = readUpdateState(env.dataDir)
  const expected = seen.patchVersion ?? seen.latestVersion ?? running
  try {
    if (!(await serviceRunsDaemon(env))) {
      out(`${PREFIX} ${NOT_RUN_BY_SERVICE}`)
      // Waiting a day changes nothing here, so the daemon is told not to try again until the install or the service does.
      return fail(expected, NOT_RUN_BY_SERVICE, true)
    }
    const applied = await applyUpdate(logged, { dryRun: false, patchOnly: true, onInterrupt }, deps, boundedInstall(deps, fd ?? 'ignore'))
    if (applied.outcome === 'updated' && applied.latest !== null) mergeAutoState(env.dataDir, { updated: { version: applied.latest, previous: running, at: env.now() }, failure: null })
    if (applied.outcome === 'failed') return fail(applied.latest ?? expected, (lines.at(-1) ?? 'the update failed').replace(`${PREFIX} `, ''))
    return applied.code
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * The run the dashboard's Install button starts, detached like the automatic
 * one: the staged release only, logged to the same file, its result saved in
 * updates/run.json for the page, which waits through the daemon's restart.
 */
async function runStaged(env: InstallEnv, deps: UpdateDeps, onInterrupt: () => void, version: string): Promise<number> {
  const { logged, lines, fd } = autoLog(env)
  const running = deps.version ?? VERSION
  const record = (state: 'updated' | 'failed', message: string | null): void => writeInstallRun(env.dataDir, { version, previous: running, state, message, at: env.now() })
  try {
    if (!(await serviceRunsDaemon(env))) {
      logged.out(`${PREFIX} ${NOT_RUN_BY_SERVICE}`)
      record('failed', NOT_RUN_BY_SERVICE)
      return EXIT_FAILED
    }
    const applied = await applyUpdate(logged, { dryRun: false, patchOnly: false, staged: version, onInterrupt }, deps, boundedInstall(deps, fd ?? 'ignore'))
    if (applied.outcome === 'updated') record('updated', null)
    else record('failed', (lines.at(-1) ?? 'the update failed').replace(`${PREFIX} `, ''))
    return applied.code
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export async function runUpdate(env: InstallEnv, options: { dryRun: boolean; auto?: boolean; staged?: string }, deps: UpdateDeps = {}): Promise<number> {
  if (env.mode.kind === 'checkout') {
    env.out(`${PREFIX} this is a checkout install; update it with git pull and bun src/cli/kinfold.ts install`)
    return EXIT_FAILED
  }
  if (isDevVersion(deps.version ?? VERSION)) {
    env.out(`${PREFIX} this is a development build; update it with git pull`)
    return EXIT_FAILED
  }
  if (options.dryRun) return (await applyUpdate(env, { dryRun: true, patchOnly: false }, deps, runnerFor(env, deps))).code
  // Two installs replacing the same program at once would each stop and start the service under the other.
  const lock = acquireUpdateLock(env.dataDir, deps.lock)
  if (lock === null) {
    // The daemon's own run finds the user's update in progress and has nothing to add.
    if (options.auto === true) return EXIT_OK
    if (options.staged !== undefined) {
      writeInstallRun(env.dataDir, { version: options.staged, previous: deps.version ?? VERSION, state: 'failed', message: 'another update is running; nothing was changed', at: env.now() })
      return EXIT_FAILED
    }
    const holder = updateLockHolder(env.dataDir, deps.lock?.alive)
    env.out(`${PREFIX} another update is running${holder === null ? '' : ` (pid ${holder})`}; nothing was changed`)
    return EXIT_FAILED
  }
  try {
    if (options.auto === true) return await runAuto(env, deps, lock.release)
    if (options.staged !== undefined) return await runStaged(env, deps, lock.release, options.staged)
    return (await applyUpdate(env, { dryRun: false, patchOnly: false, onInterrupt: lock.release }, deps, runnerFor(env, deps))).code
  } finally {
    lock.release()
  }
}
