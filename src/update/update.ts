// `kinfold update`, run only when the user asks. It downloads the latest
// release's program for this platform next to the installed one, checks it
// against that release's SHA256SUMS, and only then hands over: the new program
// runs `install --yes`, whose own release check, service stop, atomic replace
// and restart are the same steps a fresh install takes. Until that hand-off
// nothing but the temp file exists, and the temp file is removed on every path,
// so a cut-off or tampered download leaves the running program and its
// service as they were.

import { closeSync, fsyncSync, mkdirSync, openSync, rmSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { envName } from '../env-names'
import type { InstallEnv } from '../install/env'
import { installedProgramPath } from '../install/entry'
import { RELEASE_BASE, fetchReleaseSums, fileSha256, parseSha256Sums, releaseAssetName, releaseSumsUrl } from '../install/self-install'
import { currentChannel, readInstallRecord } from '../install/setup/record'
import { VERSION } from '../version'
import { UpdateCheckError, fetchLatestRelease } from './check'
import { compareVersions, parseVersion } from './version-order'

export const MAX_PROGRAM_BYTES = 300_000_000
export const DOWNLOAD_TIMEOUT_MS = 300_000

const EXIT_OK = 0
const EXIT_FAILED = 1
const TEMP_MODE = 0o700
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

function tempPath(env: InstallEnv): string {
  const suffix = env.platform === 'win32' ? '.exe' : ''
  return join(dirname(installedProgramPath(env.dataDir, env.platform)), `.kinfold-update-${process.pid}${suffix}`)
}

function tooLarge(): UpdateStop {
  return new UpdateStop('the program download is far larger than a release build; nothing was changed')
}

/** Streams the body to `path` and stops at the cap; a longer body is refused, not truncated. */
async function download(env: InstallEnv, url: string, path: string, cap: number): Promise<void> {
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
  mkdirSync(dirname(path), { recursive: true, mode: BIN_DIR_MODE })
  const fd = openSync(path, 'w', TEMP_MODE)
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
  return [
    `kinfold update: ${running} -> ${latest} (dry run; nothing is downloaded or changed)`,
    `  1. download ${releaseSumsUrl(env.envVars ?? {}, latest)}`,
    `  2. download ${programUrl(latest, assetName)} to ${temp} (mode 0700, at most ${MAX_PROGRAM_BYTES} bytes)`,
    `  3. check its sha256 against the ${assetName} line of SHA256SUMS; a mismatch stops here with nothing changed`,
    `  4. run ${temp} --data-dir ${env.dataDir} install --yes with ${envName('INSTALL_CHANNEL')}=${channel}:`,
    `     it checks itself against its release, stops the service, replaces ${binPath}, installs its libraries and starts the service again`,
    `  5. remove ${temp}`,
  ]
}

const SIGNAL_EXITS: Readonly<Record<'SIGINT' | 'SIGTERM', number>> = { SIGINT: 130, SIGTERM: 143 }

/**
 * A Ctrl-C mid-download would skip the finally below; this removes the temp
 * file first. During the hand-off the child gets the same Ctrl-C and decides,
 * so this process only waits for it and cleans up afterwards.
 */
function guardSignals(temp: string): { handingOff(): void; release(): void } {
  let waiting = false
  const handlers = Object.entries(SIGNAL_EXITS).map(([signal, code]) => {
    const handler = (): void => {
      if (waiting) return
      rmSync(temp, { force: true })
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

async function handOff(env: InstallEnv, temp: string, running: string, latest: string, run: NonNullable<UpdateDeps['runProgram']>): Promise<number> {
  const binPath = installedProgramPath(env.dataDir, env.platform)
  const before = await hashOrNull(binPath)
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
  const unchanged = before !== null && (await hashOrNull(binPath)) === before
  env.out(unchanged
    ? `${PREFIX} the new program's install stopped (exit ${code}); ${binPath} is still ${running}`
    : `${PREFIX} the new program's install stopped (exit ${code}) after replacing ${binPath}; run kinfold install to finish`)
  return EXIT_FAILED
}

export async function runUpdate(env: InstallEnv, options: { dryRun: boolean }, deps: UpdateDeps = {}): Promise<number> {
  if (env.mode.kind === 'checkout') {
    env.out(`${PREFIX} this is a checkout install; update it with git pull and bun src/cli/kinfold.ts install`)
    return EXIT_FAILED
  }
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
  const temp = tempPath(env)
  if (options.dryRun) {
    for (const line of describeDryRun(env, running, latest, assetName, temp)) env.out(line)
    return EXIT_OK
  }
  const signals = guardSignals(temp)
  try {
    const expected = await fetchExpectedHash(env, latest, assetName)
    await download(env, programUrl(latest, assetName), temp, deps.maxProgramBytes ?? MAX_PROGRAM_BYTES)
    if ((await fileSha256(temp)) !== expected) throw new UpdateStop('the downloaded program does not match the release checksums; nothing was changed')
    env.out(`kinfold update: ${latest} downloaded and checked; installing it`)
    signals.handingOff()
    return await handOff(env, temp, running, latest, deps.runProgram ?? spawnProgram)
  } catch (error: unknown) {
    if (!(error instanceof UpdateStop)) throw error
    env.out(`${PREFIX} ${error.message}`)
    return EXIT_FAILED
  } finally {
    rmSync(temp, { force: true })
    signals.release()
  }
}
