// Local build of sqlite3mc. The zip's sha256 is checked
// before anything is read from it; then only the amalgamation members are
// inflated in process (no unzip subprocess, and no member name ever becomes a
// path), written into an empty directory, and compiled with the system C
// compiler. The caller records the built library's sha256.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { AMALGAMATION_MEMBERS, MAX_SQLITE3MC_ZIP_BYTES, SQLITE3MC_DEFINES, SQLITE3MC_ZIP_SHA256 } from './release'

export const MAX_MEMBER_BYTES = 40_000_000
export const BUILD_TIMEOUT_MS = 180_000

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const STORED = 0
const DEFLATED = 8

export class BuildError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuildError'
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** The named members of a zip, inflated; a missing member, a bad header, a read past the end or an oversized member throws a BuildError. */
export function zipMembers(zip: Uint8Array, names: readonly string[]): Map<string, Uint8Array> {
  try {
    return readMembers(zip, names)
  } catch (error: unknown) {
    if (error instanceof BuildError) throw error
    throw new BuildError(`zip is damaged (${error instanceof Error ? error.name : 'error'})`)
  }
}

function readMembers(zip: Uint8Array, names: readonly string[]): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = -1
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 65_535); at--) {
    if (view.getUint32(at, true) === EOCD) { eocd = at; break }
  }
  if (eocd < 0) throw new BuildError('not a zip: no end of central directory')
  const entries = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const wanted = new Set(names)
  const out = new Map<string, Uint8Array>()
  for (let i = 0; i < entries; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new BuildError('zip central directory is damaged')
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const size = view.getUint32(at + 24, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const local = view.getUint32(at + 42, true)
    const name = new TextDecoder().decode(zip.subarray(at + 46, at + 46 + nameLength))
    at += 46 + nameLength + extraLength + commentLength
    if (!wanted.has(name)) continue
    if (size > MAX_MEMBER_BYTES) throw new BuildError(`zip member ${name} is too large`)
    if (view.getUint32(local, true) !== LOCAL) throw new BuildError(`zip member ${name} has no local header`)
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true)
    const data = zip.subarray(start, start + compressed)
    const bytes = method === STORED ? data : method === DEFLATED ? inflateRawSync(data, { maxOutputLength: MAX_MEMBER_BYTES }) : null
    if (bytes === null) throw new BuildError(`zip member ${name} uses compression method ${method}`)
    if (bytes.length !== size) throw new BuildError(`zip member ${name} inflated to the wrong size`)
    out.set(name, new Uint8Array(bytes))
  }
  const missing = names.filter((name) => !out.has(name))
  if (missing.length > 0) throw new BuildError(`zip lacks ${missing.join(', ')}`)
  return out
}

/** The compiler command for this platform, or null on a platform Kinfold does not build for. */
export function compileCommand(platform: string, source: string, output: string, cc: string): string[] | null {
  const common = ['-O2', '-fPIC', ...SQLITE3MC_DEFINES, '-o', output, source, '-lm']
  if (platform === 'darwin') return [cc, '-dynamiclib', ...common]
  if (platform === 'linux') return [cc, '-shared', '-Wl,-Bsymbolic', ...common, '-lpthread']
  // Windows has no -fPIC or -lm, and MinGW gcc links a DLL that exports every global
  // symbol; MSVC would need a .def file to export the SQLite API. libgcc is linked
  // statically so the DLL does not depend on the MinGW runtime being installed.
  if (platform === 'win32') return [cc, '-shared', '-O2', ...SQLITE3MC_DEFINES, '-o', output, source, '-static-libgcc']
  return null
}

/** The C compiler assumed when the caller names none. */
export function defaultCompiler(platform: string): string {
  return platform === 'win32' ? 'gcc' : 'cc'
}

/** Runs the compiler in `cwd`; a compiler that cannot be started or exits nonzero throws a BuildError. */
export function runCompiler(command: readonly string[], cwd: string): void {
  try {
    const result = Bun.spawnSync([...command], { cwd, stdout: 'ignore', stderr: 'pipe', timeout: BUILD_TIMEOUT_MS })
    if (result.exitCode !== 0) {
      const tail = result.stderr.toString().trim().split('\n').slice(-3).join(' | ')
      throw new BuildError(`compiler failed (exit ${result.exitCode ?? 'timeout'}): ${tail}`)
    }
  } catch (error: unknown) {
    if (error instanceof BuildError) throw error
    throw new BuildError(`compiler ${command[0]} could not be run; is a C compiler installed?`)
  }
}

export interface BuildInput {
  zip: Uint8Array
  /** Must be empty or missing; the build writes only here. */
  workDir: string
  output: string
  platform?: string
  cc?: string
}

/** Checks the pin, unpacks the amalgamation into `workDir`, compiles it to `output`, and returns the library's sha256. */
export function buildSqlite3mc(input: BuildInput): string {
  if (input.zip.length > MAX_SQLITE3MC_ZIP_BYTES) throw new BuildError('sqlite3mc zip is larger than expected')
  if (sha256(input.zip) !== SQLITE3MC_ZIP_SHA256) throw new BuildError('sqlite3mc zip does not match the pinned sha256')
  mkdirSync(input.workDir, { recursive: true, mode: 0o700 })
  if (readdirSync(input.workDir).length > 0) throw new BuildError('build directory is not empty')
  for (const [name, bytes] of zipMembers(input.zip, AMALGAMATION_MEMBERS)) writeFileSync(join(input.workDir, name), bytes, { mode: 0o600 })
  const platform = input.platform ?? process.platform
  const command = compileCommand(platform, join(input.workDir, 'sqlite3mc_amalgamation.c'), input.output, input.cc ?? defaultCompiler(platform))
  if (command === null) throw new BuildError(`no local sqlite3mc build for ${platform}`)
  runCompiler(command, input.workDir)
  return sha256(readFileSync(input.output))
}
