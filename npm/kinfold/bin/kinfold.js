#!/usr/bin/env node
// The npm entry point for Kinfold. One native program per platform is too large
// for a single package, so npm installs @kinfold/cli-<platform>-<arch> beside
// this file, and this launcher starts the program in it. Only node: builtins are
// used, and the file is CommonJS, so Node 18 and Bun both run it with no
// dependencies.

'use strict'

const { spawnSync } = require('node:child_process')
const { accessSync, chmodSync, constants, existsSync } = require('node:fs')
const { dirname, join } = require('node:path')

/** npm's platform and architecture names, beside the package that carries each program. */
const PACKAGES = {
  'darwin-arm64': '@kinfold/cli-darwin-arm64',
  'darwin-x64': '@kinfold/cli-darwin-x64',
  'linux-x64': '@kinfold/cli-linux-x64',
  'linux-arm64': '@kinfold/cli-linux-arm64',
  'win32-x64': '@kinfold/cli-windows-x64',
}

const SUPPORTED = 'macOS (arm64, x64), Linux glibc (x64, arm64), Windows x64'

function packageName(platform, arch) {
  return PACKAGES[`${platform}-${arch}`] ?? null
}

/** The musl loaders, which exist on Alpine-style systems and not on glibc ones. */
const MUSL_LOADERS = ['/lib/ld-musl-x86_64.so.1', '/lib/ld-musl-aarch64.so.1']

/**
 * True on a Linux whose C library is musl. Node reports the glibc version it
 * runs on and leaves the field out on musl, so a report settles it. Bun's
 * report never names glibc, so under Bun there is no report and the musl loader
 * files decide.
 */
function isMusl(platform, report, probe) {
  if (platform !== 'linux') return false
  if (report !== null && report !== undefined && report.header !== undefined) {
    return report.header.glibcVersionRuntime === undefined
  }
  return MUSL_LOADERS.some((path) => probe(path))
}

/**
 * The diagnostic report, read only on Linux, the one platform whose answer
 * depends on it, and never under Bun, whose report says nothing about the C
 * library. Generating it costs time on every launch, and the network interface
 * listing it would otherwise include is not needed.
 */
function currentReport(platform) {
  if (platform !== 'linux' || process.versions.bun !== undefined) return null
  try {
    if (process.report === undefined || typeof process.report.getReport !== 'function') return null
    process.report.excludeNetwork = true
    return process.report.getReport()
  } catch {
    return null
  }
}

function programName(platform) {
  return platform === 'win32' ? 'kinfold.exe' : 'kinfold'
}

function unsupportedMessage(platform, arch) {
  return `kinfold: no build for ${platform}-${arch}. Supported: ${SUPPORTED}.`
}

/** The program in the platform package, or null when that package is not installed. */
function resolveProgram(pkg, platform) {
  try {
    const manifest = require.resolve(`${pkg}/package.json`)
    return join(dirname(manifest), programName(platform))
  } catch {
    return null
  }
}

/** npm may not keep the executable bit on a package file, and the spawn needs it. */
function ensureExecutable(program, platform) {
  if (platform === 'win32') return
  try {
    accessSync(program, constants.X_OK)
  } catch {
    try {
      chmodSync(program, 0o755)
    } catch {
      // The spawn below reports the real failure.
    }
  }
}

function main() {
  const platform = process.platform
  const arch = process.arch
  const musl = isMusl(platform, currentReport(platform), existsSync)
  const pkg = musl ? null : packageName(platform, arch)
  const program = pkg === null ? null : resolveProgram(pkg, platform)
  if (program === null) {
    process.stderr.write(`${unsupportedMessage(musl ? 'linux-musl' : platform, arch)}\n`)
    process.exit(1)
  }

  ensureExecutable(program, platform)
  const argv = process.argv.slice(2)
  // `npx kinfold` with no subcommand opens the installer.
  const args = argv.length === 0 ? ['install'] : argv
  const result = spawnSync(program, args, { stdio: 'inherit' })
  if (result.error !== undefined) {
    process.stderr.write(`kinfold: could not run ${program}: ${result.error.message}\n`)
    process.exit(1)
  }
  if (result.signal !== null) {
    // Die by the signal the program saw, so a caller sees the same status.
    try {
      process.kill(process.pid, result.signal)
    } catch {
      process.exit(1)
    }
    return
  }
  process.exit(result.status === null ? 1 : result.status)
}

module.exports = { main, isMusl, currentReport, packageName, programName, unsupportedMessage }

if (require.main === module) main()
