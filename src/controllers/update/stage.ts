// Staging a release that waits for the user's yes: a minor, a major, or a
// beta. At the patch level the daemon downloads its program in the
// background into <dataDir>/updates/, checks it against that release's
// SHA256SUMS, and keeps it there for `kinfold update` or the dashboard's
// Install button. One release is staged at a time: a newer one replaces it,
// a failed check deletes it, and once its version runs it is removed. Nothing
// here runs the program; the install re-checks it against SHA256SUMS first.

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../system/fs/atomic'
import { fetchReleaseSums, fileSha256, parseSha256Sums, releaseAssetName, RELEASE_BASE } from '../install/self-install'
import { readInstallRecord } from '../../resources/install-plan/setup/record'
import { osOf } from '../../system/platform/platform'
import { DATA_FILE_MODE } from '../../resources/store/data-dir'
import { autoUpdateSetting, betaChannelOn } from './enabled'
import { releaseKind } from './release'
import { knownRelease, readUpdateState } from './state'
import { compareVersions, parseVersion } from './version-order'
import { isRecord } from '../../system/contract/event'
import { isTime } from './auto-state'

type Env = Readonly<Record<string, string | undefined>>

export const STAGE_DIR = 'updates'
export const STAGE_RECORD = 'staged.json'
/** A release build is well under this; anything near it is not one. */
export const MAX_PROGRAM_BYTES = 300_000_000
export const STAGE_DOWNLOAD_TIMEOUT_MS = 300_000
const DIR_MODE = 0o700
const DOWNLOAD_MODE = 0o600
const VERIFIED_MODE = 0o700
/** What staging writes in the folder, and so all it ever removes. */
const OURS = /^(?:\.part-)?kinfold-[\w.+-]+$/

export interface StagedRecord {
  version: string
  asset: string
  sha256: string
  /** Size and modification time when staged: a file changed since is not offered. */
  size: number
  mtimeMs: number
  at: number
}

export interface StageFailure {
  version: string
  /** The daily check that found the release; only a later one allows another try. */
  checkedAt: number | null
  at: number
  reason: string
}

export interface StageState {
  staged: StagedRecord | null
  failure: StageFailure | null
}

const stageDir = (dataDir: string): string => join(dataDir, STAGE_DIR)

/** Where a staged program lives: the asset name with the version, so two releases never share a file. */
function stagedName(version: string, platform: NodeJS.Platform): string {
  return `kinfold-${version}${osOf(platform) === 'windows' ? '.exe' : ''}`
}

function stagedOf(value: unknown): StagedRecord | null {
  if (!isRecord(value)) return null
  const { version, asset, sha256, size, mtimeMs, at } = value
  if (typeof version !== 'string' || parseVersion(version) === null || typeof asset !== 'string' || typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  if (!isTime(size) || !isTime(mtimeMs) || !isTime(at)) return null
  return { version, asset, sha256, size, mtimeMs, at }
}

function failureOf(value: unknown): StageFailure | null {
  if (!isRecord(value)) return null
  const { version, checkedAt, at, reason } = value
  if (typeof version !== 'string' || !isTime(at) || typeof reason !== 'string') return null
  return { version, checkedAt: isTime(checkedAt) ? checkedAt : null, at, reason }
}

/** Missing or malformed reads as empty: the cost is one more download. */
export function readStageRecord(dataDir: string): StageState {
  try {
    const value: unknown = JSON.parse(readFileSync(join(stageDir(dataDir), STAGE_RECORD), 'utf8'))
    return isRecord(value) ? { staged: stagedOf(value.staged), failure: failureOf(value.failure) } : { staged: null, failure: null }
  } catch {
    return { staged: null, failure: null }
  }
}

function writeStageRecord(dataDir: string, state: StageState): void {
  mkdirSync(stageDir(dataDir), { recursive: true, mode: DIR_MODE })
  writeFileAtomic(join(stageDir(dataDir), STAGE_RECORD), `${JSON.stringify(state, null, 2)}\n`, DATA_FILE_MODE)
}

export interface StagedProgram {
  version: string
  path: string
  sha256: string
  asset: string
}

/** The staged program, while its file is the one that was checked; null otherwise. Reads only. */
export function stagedProgram(dataDir: string, platform: NodeJS.Platform): StagedProgram | null {
  const staged = readStageRecord(dataDir).staged
  if (staged === null) return null
  const path = join(stageDir(dataDir), stagedName(staged.version, platform))
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size !== staged.size || stat.mtimeMs !== staged.mtimeMs) return null
  } catch {
    return null
  }
  return { version: staged.version, path, sha256: staged.sha256, asset: staged.asset }
}

/** Removes every file staging wrote, except `keep`. Other files in the folder are left alone. */
function removeOurs(dataDir: string, keep: string | null = null): void {
  const dir = stageDir(dataDir)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    if (name === keep || !OURS.test(name)) continue
    try {
      if (statSync(join(dir, name)).isFile()) rmSync(join(dir, name), { force: true })
    } catch {
      // A file that cannot be removed now is tried again on the next tick.
    }
  }
}

/** Removes the staged program and its record: uninstall, and once the staged version runs. */
export function removeStaged(dataDir: string): void {
  removeOurs(dataDir)
  rmSync(join(stageDir(dataDir), STAGE_RECORD), { force: true })
}

export type StageHold = 'off' | 'none' | 'no-build' | 'ready' | 'tried'
export type StageDecision = { stage: true; version: string; checkedAt: number | null; asset: string } | { stage: false; reason: StageHold }

export interface StageInput {
  dataDir: string
  running: string
  env: Env
  platform: NodeJS.Platform
  arch: string
}

/**
 * Whether to download a release now. Only at the patch level, where the
 * install could also apply patches itself, and only for a release that is
 * newer and bigger than a patch: a patch installs itself.
 */
export function stageDecision(input: StageInput): StageDecision {
  const record = readInstallRecord(input.dataDir)
  if (!autoUpdateSetting(input.running, record, input.env).on) return { stage: false, reason: 'off' }
  const state = readUpdateState(input.dataDir)
  const release = knownRelease(state, betaChannelOn(record, input.running))
  if (release === null || compareVersions(release.version, input.running) <= 0 || releaseKind(input.running, release.version) === 'patch') return { stage: false, reason: 'none' }
  const asset = releaseAssetName(input.platform, input.arch)
  if (asset === null) return { stage: false, reason: 'no-build' }
  if (stagedProgram(input.dataDir, input.platform)?.version === release.version) return { stage: false, reason: 'ready' }
  const failure = readStageRecord(input.dataDir).failure
  if (failure !== null && failure.version === release.version && failure.checkedAt === state.checkedAt) return { stage: false, reason: 'tried' }
  return { stage: true, version: release.version, checkedAt: state.checkedAt, asset }
}

export interface StageDeps {
  dataDir: string
  /** The running version. */
  version: string
  platform: NodeJS.Platform
  arch: string
  fetch: (url: string, init: RequestInit) => Promise<Response>
  envVars: () => Env
  now: () => number
  log: (line: string) => void
  /** Default MAX_PROGRAM_BYTES; a test lowers it. */
  maxProgramBytes?: number
}

class StageStop extends Error {}

async function download(deps: StageDeps, url: string, path: string, cap: number): Promise<void> {
  let response: Response
  try {
    response = await deps.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(STAGE_DOWNLOAD_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new StageStop(`could not download the program (${error instanceof Error ? error.name : 'error'})`)
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new StageStop(`the program download answered ${response.status}`)
  }
  if (Number(response.headers.get('content-length') ?? 0) > cap) {
    await response.body?.cancel().catch(() => undefined)
    throw new StageStop('the program download is far larger than a release build')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new StageStop('the program download was empty')
  // Exclusive: a file or link already at this name is never followed.
  const fd = openSync(path, 'wx', DOWNLOAD_MODE)
  try {
    let size = 0
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>
      try {
        chunk = await reader.read()
      } catch (error: unknown) {
        throw new StageStop(`the program download was cut off (${error instanceof Error ? error.name : 'error'})`)
      }
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > cap) {
        await reader.cancel().catch(() => undefined)
        throw new StageStop('the program download is far larger than a release build')
      }
      writeSync(fd, chunk.value)
    }
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

async function expectedHash(deps: StageDeps, version: string, asset: string): Promise<string> {
  let expected: string | undefined
  try {
    expected = parseSha256Sums(await fetchReleaseSums({ fetch: deps.fetch, envVars: deps.envVars() }, version)).get(asset)
  } catch (error: unknown) {
    throw new StageStop((error instanceof Error ? error.message : 'could not read SHA256SUMS').replace('; nothing was written', ''))
  }
  if (expected === undefined) throw new StageStop(`SHA256SUMS has no entry for ${asset}`)
  return expected
}

/** Downloads and checks one release. Leaves either the checked program and its record, or nothing new. */
async function stage(deps: StageDeps, decision: Extract<StageDecision, { stage: true }>): Promise<'staged' | 'failed'> {
  const dir = stageDir(deps.dataDir)
  const name = stagedName(decision.version, deps.platform)
  const part = join(dir, `.part-${name}`)
  const final = join(dir, name)
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    chmodSync(dir, DIR_MODE)
    // A part left by a daemon that stopped mid-download is this daemon's own leftover.
    rmSync(part, { force: true })
    const expected = await expectedHash(deps, decision.version, decision.asset)
    await download(deps, `${RELEASE_BASE}/v${decision.version}/${decision.asset}`, part, deps.maxProgramBytes ?? MAX_PROGRAM_BYTES)
    if ((await fileSha256(part)) !== expected) throw new StageStop('the downloaded program does not match the release checksums')
    chmodSync(part, VERIFIED_MODE)
    renameSync(part, final)
    const stat = statSync(final)
    writeStageRecord(deps.dataDir, { staged: { version: decision.version, asset: decision.asset, sha256: expected, size: stat.size, mtimeMs: stat.mtimeMs, at: deps.now() }, failure: null })
    removeOurs(deps.dataDir, name)
    deps.log(`staged ${decision.version}; kinfold update installs it`)
    return 'staged'
  } catch (error: unknown) {
    rmSync(part, { force: true })
    // The name only for an unexpected error: a file system message carries the path.
    const reason = error instanceof StageStop ? error.message : `could not write the download (${(error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.name : 'error')})`
    const current = readStageRecord(deps.dataDir)
    writeStageRecord(deps.dataDir, { staged: current.staged, failure: { version: decision.version, checkedAt: decision.checkedAt, at: deps.now(), reason } })
    deps.log(`could not stage ${decision.version}: ${reason}`)
    return 'failed'
  }
}

/** One look: stage the release on offer, or clear a staged one that is no longer newer. Never throws. */
export async function runStageTick(deps: StageDeps): Promise<StageHold | 'staged' | 'failed'> {
  try {
    const staged = readStageRecord(deps.dataDir).staged
    const passed = staged !== null && parseVersion(deps.version) !== null && compareVersions(staged.version, deps.version) <= 0
    // A beta kept after the user left the channel would never be offered again; it only takes space.
    const leftBeta = staged !== null && parseVersion(staged.version)?.pre != null && !betaChannelOn(readInstallRecord(deps.dataDir), deps.version)
    if (passed || leftBeta) removeStaged(deps.dataDir)
    const decision = stageDecision({ dataDir: deps.dataDir, running: deps.version, env: deps.envVars(), platform: deps.platform, arch: deps.arch })
    return decision.stage ? await stage(deps, decision) : decision.reason
  } catch (error: unknown) {
    deps.log(`staging failed (${error instanceof Error ? error.name : 'error'})`)
    return 'failed'
  }
}

export const STAGE_TICK_MS = 60_000

/** The daemon's tick; a download in progress is never started twice. */
export function startStaging(deps: StageDeps, tickMs: number = STAGE_TICK_MS): { stop(): void } {
  let running = false
  const tick = (): void => {
    if (running) return
    running = true
    void runStageTick(deps).finally(() => {
      running = false
    })
  }
  const timer = setInterval(tick, tickMs)
  return { stop: () => clearInterval(timer) }
}

