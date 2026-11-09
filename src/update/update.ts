// `kinfold update`, run only when the user asks. It downloads the latest
// release's program for this platform next to the installed one, checks it
// against that release's SHA256SUMS, and only then hands over: the new program
// runs `install --yes`, whose own release check, service stop, atomic replace
// and restart are the same steps a fresh install takes. Until that hand-off
// nothing but the temp file exists, and the temp file is removed on every path,
// so a cut-off or tampered download leaves the running program and its
// service as they were. A run killed outright (SIGKILL, a crash, a power loss)
// cannot clean up, so each run first removes the temp files of runs no longer alive.

import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { envName } from '../env-names'
import type { InstallEnv } from '../install/env'
import { serviceOf } from '../install/service/control'
import { installedProgramPath } from '../install/entry'
import { restartService } from '../install/install'
import { RELEASE_BASE, fetchReleaseSums, fileSha256, parseSha256Sums, releaseAssetName, releaseSumsUrl } from '../install/self-install'
import { currentChannel, readInstallRecord } from '../install/setup/record'
import { VERSION } from '../version'
import { UpdateCheckError, fetchLatestRelease } from './check'
import { compareVersions, parseVersion } from './version-order'

export const MAX_PROGRAM_BYTES = 300_000_000
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
}

/** Failures before the hand-off: each message already says nothing was changed. */
class UpdateStop extends Error {}

async function spawnProgram(path: string, argv: readonly string[], env: Readonly<Record<string, string>>): Promise<number> {
  // No stdin: `install --yes` never asks, and a question it did reach could not hang on a pipe.
  const child = Bun.spawn([path, ...argv], { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', env: { ...env } })
  return child.exited
}

/** The child's environment: this one's, as strings, with the saved channel. */
function childEnv(env: InstallEnv): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(env.envVars ?? {})) if (typeof value === 'string') vars[key] = value
  vars[envName('INSTALL_CHANNEL')] = currentChannel(env, readInstallRecord(env.dataDir))
  return vars
}

function binDir(env: InstallEnv): string {
  return dirname(installedProgramPath(env.dataDir, env.platform))
}

function tempPath(env: InstallEnv): string {
  const suffix = env.platform === 'win32' ? '.exe' : ''
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
function guardSignals(temp: TempFile): { handingOff(): void; release(): void } {
  let waiting = false
  const handlers = Object.entries(SIGNAL_EXITS).map(([signal, code]) => {
    const handler = (): void => {
      if (waiting) return
      removeTemp(temp)
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
  if (service === null) return 'this platform has no background service'
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

async function handOff(env: InstallEnv, temp: string, running: string, latest: string, run: NonNullable<UpdateDeps['runProgram']>): Promise<number> {
  const binPath = installedProgramPath(env.dataDir, env.platform)
  const before = await hashOrNull(binPath)
  const wasRunning = await isRunning(env)
  let code: number
  try {
    code = await run(temp, ['--data-dir', env.dataDir, 'install', '--yes'], childEnv(env))
  } catch (error: unknown) {
    env.out(`${PREFIX} could not start the new program (${error instanceof Error ? error.name : 'error'}); ${binPath} is still ${running}`)
    return EXIT_FAILED
  }
  if (code === EXIT_OK) {
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

export async function runUpdate(env: InstallEnv, options: { dryRun: boolean }, deps: UpdateDeps = {}): Promise<number> {
  if (env.mode.kind === 'checkout') {
    env.out(`${PREFIX} this is a checkout install; update it with git pull and bun src/cli/kinfold.ts install`)
    return EXIT_FAILED
  }
  // A dry run only lists these (describeDryRun); it removes nothing.
  if (!options.dryRun) sweepLeftovers(env)
  const running = deps.version ?? VERSION
  let latest: string
  try {
    latest = (await fetchLatestRelease(env.fetch, env.now)).latestVersion
  } catch (error: unknown) {
    env.out(`${PREFIX} could not ask GitHub for the latest release (${error instanceof UpdateCheckError ? error.label : 'error'})`)
    return EXIT_FAILED
  }
  if (parseVersion(running) !== null && compareVersions(latest, running) <= 0) {
    env.out(`kinfold is up to date (${running})`)
    return EXIT_OK
  }
  const arch = env.arch ?? process.arch
  const assetName = releaseAssetName(env.platform, arch)
  if (assetName === null) {
    env.out(`${PREFIX} no release build for ${env.platform}-${arch}`)
    return EXIT_FAILED
  }
  const temp: TempFile = { path: tempPath(env), created: false }
  if (options.dryRun) {
    for (const line of describeDryRun(env, running, latest, assetName, temp.path)) env.out(line)
    return EXIT_OK
  }
  const signals = guardSignals(temp)
  try {
    const expected = await fetchExpectedHash(env, latest, assetName)
    await download(env, programUrl(latest, assetName), temp, deps.maxProgramBytes ?? MAX_PROGRAM_BYTES)
    if ((await fileSha256(temp.path)) !== expected) throw new UpdateStop('the downloaded program does not match the release checksums; nothing was changed')
    chmodSync(temp.path, VERIFIED_MODE)
    env.out(`kinfold update: ${latest} downloaded and checked; installing it`)
    signals.handingOff()
    return await handOff(env, temp.path, running, latest, deps.runProgram ?? spawnProgram)
  } catch (error: unknown) {
    // handOff catches its own failures, so anything here came before it: a full
    // disk or a permission error while writing the download.
    const message = error instanceof UpdateStop ? error.message : `could not write the download (${errorLabel(error)}); nothing was changed`
    env.out(`${PREFIX} ${message}`)
    return EXIT_FAILED
  } finally {
    removeTemp(temp)
    signals.release()
  }
}
