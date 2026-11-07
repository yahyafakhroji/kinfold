// `kinfold install` puts the running program at <dataDir>/bin/kinfold, the
// fixed path every host entry names. A release build is checked against the
// SHA256SUMS of the release it came from before any other step can change the
// machine; a development build skips that check and says so. The copy goes
// through a temp file in the bin folder, is fsynced and made executable, then
// renamed, so a failure never leaves the old program half replaced.

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnv } from '../env-names'
import { VERSION } from '../version'
import type { InstallEnv } from './env'
import type { Action } from './plan'

export const DEVELOPMENT_VERSION = '0.0.0-dev'
export const RELEASE_BASE = 'https://github.com/yahyafakhroji/kinfold/releases/download'
export const SUMS_TIMEOUT_MS = 30_000
/** The five release files take a few hundred bytes; a megabyte is not the checksum list. */
export const MAX_SUMS_BYTES = 1_000_000

const PROGRAM_MODE = 0o755
const PROGRAM_DIR_MODE = 0o700
const SUMS_LINE = /^([0-9a-f]{64}) {2}([^\s/\\]+)$/
const ASSET_NAMES: Readonly<Record<string, string>> = {
  'darwin-arm64': 'kinfold-darwin-arm64',
  'darwin-x64': 'kinfold-darwin-x64',
  'linux-x64': 'kinfold-linux-x64',
  'linux-arm64': 'kinfold-linux-arm64',
  'win32-x64': 'kinfold-windows-x64.exe',
}

/** The release file for this platform and architecture; null where Kinfold has no build. */
export function releaseAssetName(platform: string, arch: string): string | null {
  return ASSET_NAMES[`${platform}-${arch}`] ?? null
}

/**
 * Hash and plain file name pairs, nothing else. A path, an upper case or short
 * hash, a single space or a repeated name makes the whole file unusable,
 * because a checksum list that is almost right is not something to install from.
 * A list generated on Windows carries CRLF; that ending is the only tolerance.
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('SHA256SUMS holds no entries; nothing was written')
  for (const raw of lines) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    const match = SUMS_LINE.exec(line)
    const hash = match?.[1]
    const name = match?.[2]
    if (hash === undefined || name === undefined || name === '.' || name === '..') {
      throw new Error('SHA256SUMS is malformed; nothing was written')
    }
    if (sums.has(name)) throw new Error(`SHA256SUMS names ${name} twice; nothing was written`)
    sums.set(name, hash)
  }
  return sums
}

/** Streams the file, so a compiled program is never read whole into memory. */
async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** True only when the file is the one the list names; a missing file is a mismatch too. */
export async function verifyProgram(path: string, assetName: string, sumsText: string): Promise<boolean> {
  const expected = parseSha256Sums(sumsText).get(assetName)
  if (expected === undefined) return false
  try {
    return (await fileSha256(path)) === expected
  } catch {
    return false
  }
}

/**
 * The GitHub release of this version, or the release candidate's own list. The
 * override exists so a candidate can be checked before its release exists; a
 * final version always comes from GitHub, even when the variable is set.
 */
export function releaseSumsUrl(envVars: Readonly<Record<string, string | undefined>> = {}, version: string = VERSION): string {
  const override = readEnv(envVars, 'RELEASE_SUMS_URL')
  if (override !== undefined && version.includes('-rc.')) return override
  return `${RELEASE_BASE}/v${version}/SHA256SUMS`
}

function readSumsFile(url: string): string {
  let path: string
  let size: number
  try {
    path = fileURLToPath(url)
    size = statSync(path).size
  } catch {
    throw new Error('could not read SHA256SUMS; nothing was written')
  }
  if (size > MAX_SUMS_BYTES) throw new Error('the SHA256SUMS file is far larger than the release; nothing was written')
  try {
    return readFileSync(path, 'utf8')
  } catch {
    throw new Error('could not read SHA256SUMS; nothing was written')
  }
}

async function fetchSums(env: InstallEnv, url: string): Promise<string> {
  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error('could not read SHA256SUMS; the URL is not valid')
  }
  if (protocol === 'file:') return readSumsFile(url)
  let response: Response
  try {
    response = await env.fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(SUMS_TIMEOUT_MS) })
  } catch (error: unknown) {
    throw new Error(`could not download SHA256SUMS (${error instanceof Error ? error.name : 'error'}); nothing was written`)
  }
  if (!response.ok) throw new Error(`the SHA256SUMS download answered ${response.status}; nothing was written`)
  if (Number(response.headers.get('content-length') ?? 0) > MAX_SUMS_BYTES) {
    throw new Error('the SHA256SUMS download is far larger than the release; nothing was written')
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > MAX_SUMS_BYTES) throw new Error('the SHA256SUMS download is far larger than the release; nothing was written')
  return new TextDecoder().decode(bytes)
}

export interface ProgramCheckOptions {
  source: string
  dryRun: boolean
  /** The release version; the CLI leaves it out so src/version.ts decides. */
  version?: string
}

export interface ProgramCheck {
  /** The running program's hash, taken once for the whole run. */
  sourceHash: string
  assetName: string | null
  /** null when a dry run may not fetch; the copy refuses without a hash. */
  expectedSha256: string | null
  check: boolean
}

export interface ProgramInstallOptions extends ProgramCheckOptions {
  /** The answer from checkProgram, taken before any change; computed here when absent. */
  check?: ProgramCheck
}

export interface ProgramInstallPlan {
  actions: Action[]
}

async function differs(path: string, expected: string): Promise<boolean> {
  try {
    return !existsSync(path) || (await fileSha256(path)) !== expected
  } catch {
    return true
  }
}

/**
 * The release check for the running program, before the rename migration or any
 * other step can change the machine. A real release run hashes the program once
 * and compares it with its SHA256SUMS; a mismatch or a failed fetch throws here.
 * The plan reuses this answer, so it never fetches or hashes the source again.
 * A dry run may not fetch, so it only knows the running hash; the plan then
 * compares the installed file with the running one.
 */
export async function checkProgram(env: InstallEnv, options: ProgramCheckOptions): Promise<ProgramCheck | null> {
  if (env.mode.kind !== 'program') return null
  const version = options.version ?? VERSION
  const arch = env.arch ?? process.arch
  const assetName = releaseAssetName(env.platform, arch)
  const development = version === DEVELOPMENT_VERSION
  if (!development && assetName === null) throw new Error(`no release build for ${env.platform}-${arch}`)
  const sourceHash = await fileSha256(options.source)
  if (development) {
    env.out('program: the release checksum check is skipped for the development version')
    return { sourceHash, assetName, expectedSha256: sourceHash, check: false }
  }
  if (options.dryRun) return { sourceHash, assetName, expectedSha256: null, check: true }
  const text = await fetchSums(env, releaseSumsUrl(env.envVars ?? {}, version))
  const expected = assetName === null ? undefined : parseSha256Sums(text).get(assetName)
  if (expected === undefined || sourceHash !== expected) throw new Error('program does not match the release checksums')
  return { sourceHash, assetName, expectedSha256: expected, check: true }
}

/**
 * The install-program step, in program mode only. The check passed in was taken
 * before the plan was built, so a mismatch has already stopped the install with
 * nothing changed.
 */
export async function programInstallActions(env: InstallEnv, options: ProgramInstallOptions): Promise<ProgramInstallPlan> {
  if (env.mode.kind !== 'program') return { actions: [] }
  const check = options.check ?? (await checkProgram(env, options))
  if (check === null) return { actions: [] }
  const destination = env.mode.binPath
  const expected = check.expectedSha256 ?? check.sourceHash
  if (!(await differs(destination, expected))) return { actions: [] }
  return {
    actions: [{ kind: 'install-program', from: options.source, to: destination, assetName: check.assetName, expectedSha256: check.expectedSha256, check: check.check }],
  }
}

/**
 * Copy the running program into place through a temp file: fsync makes the
 * bytes durable before the rename, and the rename is the only step that
 * replaces the old program, so a failure before it leaves that program as it was.
 * The temp file is hashed after the copy, so a source replaced in between is
 * refused rather than installed unchecked.
 */
export async function installProgram(env: InstallEnv, action: Extract<Action, { kind: 'install-program' }>): Promise<void> {
  const expected = action.expectedSha256
  if (expected === null) throw new Error('program does not match the release checksums')
  if (!(await differs(action.to, expected))) {
    env.out(`program: ${action.to} already matches ${action.check ? 'the release checksum' : 'the running program'}`)
    return
  }
  const dir = dirname(action.to)
  mkdirSync(dir, { recursive: true, mode: PROGRAM_DIR_MODE })
  const temp = join(dir, `.kinfold-tmp-${process.pid}`)
  try {
    copyFileSync(action.from, temp)
    const fd = openSync(temp, 'r+')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    const copied = await fileSha256(temp)
    if (copied !== expected) {
      throw new Error(action.check ? 'program does not match the release checksums' : 'the running program changed while install ran')
    }
    chmodSync(temp, PROGRAM_MODE)
    renameSync(temp, action.to)
  } catch (error: unknown) {
    rmSync(temp, { force: true })
    throw error
  }
}
