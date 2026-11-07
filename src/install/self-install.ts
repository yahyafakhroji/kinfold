// `kinfold install` puts the running program at <dataDir>/bin/kinfold, the
// fixed path every host entry names. A release build is checked against the
// SHA256SUMS of the release it came from before anything in the plan runs; a
// development build skips that check and says so. The copy goes through a temp
// file in the bin folder, is fsynced and made executable, then renamed, so a
// failure never leaves the old program half replaced.

import { createHash } from 'node:crypto'
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
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
 */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length === 0) throw new Error('SHA256SUMS holds no entries; nothing was written')
  for (const line of lines) {
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

function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** True only when the file is the one the list names; a missing file is a mismatch too. */
export async function verifyProgram(path: string, assetName: string, sumsText: string): Promise<boolean> {
  const expected = parseSha256Sums(sumsText).get(assetName)
  if (expected === undefined) return false
  try {
    return fileSha256(path) === expected
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

export interface ProgramInstallOptions {
  source: string
  dryRun: boolean
  /** The release version; the CLI leaves it out so src/version.ts decides. */
  version?: string
}

export interface ProgramInstallPlan {
  actions: Action[]
}

function differs(path: string, expected: string): boolean {
  try {
    return !existsSync(path) || fileSha256(path) !== expected
  } catch {
    return true
  }
}

/**
 * The install-program step, in program mode only. A real run checks the source
 * before the plan is applied, so a mismatch stops the install with nothing
 * changed. A dry run may not fetch the list, so it compares the installed file
 * with the running one; that is the same answer whenever the running program is
 * the release build.
 */
export async function programInstallActions(env: InstallEnv, options: ProgramInstallOptions): Promise<ProgramInstallPlan> {
  if (env.mode.kind !== 'program') return { actions: [] }
  const version = options.version ?? VERSION
  const arch = env.arch ?? process.arch
  const assetName = releaseAssetName(env.platform, arch)
  const sourceHash = fileSha256(options.source)
  const development = version === DEVELOPMENT_VERSION
  let expected: string | null = null
  if (development) {
    env.out('program: the release checksum check is skipped for the development version')
    expected = sourceHash
  } else {
    if (assetName === null) throw new Error(`no release build for ${env.platform}-${arch}`)
    if (!options.dryRun) {
      const text = await fetchSums(env, releaseSumsUrl(env.envVars ?? {}, version))
      if (!(await verifyProgram(options.source, assetName, text))) throw new Error('program does not match the release checksums')
      expected = parseSha256Sums(text).get(assetName) ?? null
    }
  }
  const destination = env.mode.binPath
  if (expected !== null && !differs(destination, expected)) return { actions: [] }
  if (expected === null && !differs(destination, sourceHash)) return { actions: [] }
  return {
    actions: [{ kind: 'install-program', from: options.source, to: destination, assetName, expectedSha256: expected, check: !development }],
  }
}

/**
 * Copy the running program into place through a temp file: fsync makes the
 * bytes durable before the rename, and the rename is the only step that
 * replaces the old program, so a failure before it leaves that program as it was.
 */
export async function installProgram(env: InstallEnv, action: Extract<Action, { kind: 'install-program' }>): Promise<void> {
  let expected = action.expectedSha256
  if (action.check) {
    if (expected === null) throw new Error('program does not match the release checksums')
    let current: string
    try {
      current = fileSha256(action.from)
    } catch {
      throw new Error('program does not match the release checksums')
    }
    if (current !== expected) throw new Error('program does not match the release checksums')
  } else if (expected === null) {
    expected = fileSha256(action.from)
  }
  if (!differs(action.to, expected)) {
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
    chmodSync(temp, PROGRAM_MODE)
    renameSync(temp, action.to)
  } catch (error: unknown) {
    rmSync(temp, { force: true })
    throw error
  }
}
