import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NPM_TARGETS, packNpm } from '../../tools/pack-npm'

const launcher = createRequire(import.meta.url)('./bin/kinfold.js') as {
  packageName(platform: string, arch: string): string | null
  programName(platform: string): string
  unsupportedMessage(platform: string, arch: string): string
  isMusl(platform: string, report: unknown, probe: (path: string) => boolean): boolean
  currentReport(platform: string): unknown
}

const LAUNCHER_FILE = join(import.meta.dir, 'bin', 'kinfold.js')
const SUPPORTED = 'Supported: macOS (arm64, x64), Linux glibc (x64, arm64), Windows x64.'
/** The fake platform program records what the launcher handed it. */
const PROGRAM = `#!/bin/sh
printf '%s\\n' "$@" > "$KINFOLD_TEST_ARGS"
cat > "$KINFOLD_TEST_STDIN"
if [ -n "\${KINFOLD_TEST_SIGNAL:-}" ]; then
  kill -s "$KINFOLD_TEST_SIGNAL" $$
fi
exit "$KINFOLD_TEST_EXIT"
`

let roots: string[] = []

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
  roots = []
})

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function installLauncher(root: string): string {
  const dir = join(root, 'node_modules', 'kinfold', 'bin')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'kinfold.js')
  writeFileSync(file, readFileSync(LAUNCHER_FILE))
  return file
}

function addProgram(root: string, packageName: string): void {
  const dir = join(root, 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: packageName, version: '0.0.0-test' })}\n`)
  writeFileSync(join(dir, 'kinfold'), PROGRAM)
  chmodSync(join(dir, 'kinfold'), 0o755)
}

interface Launched {
  exitCode: number
  signalCode: string | null
  stdout: string
  stderr: string
  argsPath: string
  root: string
}

async function launch(options: {
  platform: string
  arch: string
  argv: string[]
  packages?: string[]
  exitCode?: number
  signal?: string
  stdin?: string
  /** Runs as Node would on Alpine: no Bun version, and a report that names no glibc. */
  musl?: boolean
}): Promise<Launched> {
  const root = temp('kinfold-launcher-')
  const program = installLauncher(root)
  for (const name of options.packages ?? []) addProgram(root, name)
  const preload = join(root, 'platform.js')
  writeFileSync(
    preload,
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(options.platform)} })\nObject.defineProperty(process, 'arch', { value: ${JSON.stringify(options.arch)} })\n${
      options.musl === true ? "Object.defineProperty(process.versions, 'bun', { value: undefined, configurable: true })\nObject.defineProperty(process, 'report', { value: { getReport: () => ({ header: {} }) }, configurable: true })\n" : ''
    }`,
  )
  const argsPath = join(root, 'args.txt')
  const child = Bun.spawn([process.execPath, '--preload', preload, program, ...options.argv], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: root,
      KINFOLD_TEST_ARGS: argsPath,
      KINFOLD_TEST_STDIN: join(root, 'stdin.txt'),
      KINFOLD_TEST_EXIT: String(options.exitCode ?? 0),
      KINFOLD_TEST_SIGNAL: options.signal ?? '',
    },
    stdin: options.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, signalCode: child.signalCode, stdout, stderr, argsPath, root }
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').trim().split('\n')
}

test('each supported host maps to its package, and Windows takes the exe', () => {
  expect(launcher.packageName('darwin', 'arm64')).toBe('@kinfold/cli-darwin-arm64')
  expect(launcher.packageName('darwin', 'x64')).toBe('@kinfold/cli-darwin-x64')
  expect(launcher.packageName('linux', 'x64')).toBe('@kinfold/cli-linux-x64')
  expect(launcher.packageName('linux', 'arm64')).toBe('@kinfold/cli-linux-arm64')
  expect(launcher.packageName('win32', 'x64')).toBe('@kinfold/cli-windows-x64')
  expect(launcher.packageName('freebsd', 'x64')).toBeNull()
  expect(launcher.programName('win32')).toBe('kinfold.exe')
  expect(launcher.programName('linux')).toBe('kinfold')
})

test('the unsupported message names the host and every supported platform', () => {
  expect(launcher.unsupportedMessage('freebsd', 'x64')).toBe(`kinfold: no build for freebsd-x64. ${SUPPORTED}`)
})

const shellTest = test.skipIf(process.platform === 'win32')

shellTest('linux-arm64 runs its package with argv, stdin and the exit code', async () => {
  const result = await launch({
    platform: 'linux',
    arch: 'arm64',
    packages: ['@kinfold/cli-linux-arm64'],
    argv: ['--data-dir', '/tmp/a b', 'status'],
    exitCode: 7,
    stdin: 'hello',
  })

  expect(result.exitCode).toBe(7)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe('')
  expect(readLines(result.argsPath)).toEqual(['--data-dir', '/tmp/a b', 'status'])
  expect(readFileSync(join(result.root, 'stdin.txt'), 'utf8')).toBe('hello')
})

shellTest('a bare launcher runs install', async () => {
  const result = await launch({ platform: 'linux', arch: 'x64', packages: ['@kinfold/cli-linux-x64'], argv: [] })

  expect(result.exitCode).toBe(0)
  expect(readLines(result.argsPath)).toEqual(['install'])
})

shellTest('the launcher dies by the signal its program saw', async () => {
  const result = await launch({
    platform: 'linux',
    arch: 'x64',
    packages: ['@kinfold/cli-linux-x64'],
    argv: [],
    signal: 'TERM',
  })

  expect(result.signalCode).toBe('SIGTERM')
  expect(result.stderr).toBe('')
})

shellTest('freebsd prints the unsupported message and exits 1', async () => {
  const result = await launch({ platform: 'freebsd', arch: 'x64', argv: [] })

  expect(result.exitCode).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`kinfold: no build for freebsd-x64. ${SUPPORTED}\n`)
})

shellTest('a supported host with no platform package prints the same message', async () => {
  const result = await launch({ platform: 'darwin', arch: 'x64', argv: ['status'] })

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(`kinfold: no build for darwin-x64. ${SUPPORTED}\n`)
})

const NO_LOADER = (): boolean => false

test('only a Linux report with no glibc version is musl', () => {
  expect(launcher.isMusl('linux', { header: {} }, NO_LOADER)).toBe(true)
  expect(launcher.isMusl('linux', { header: { glibcVersionRuntime: '2.39' } }, NO_LOADER)).toBe(false)
  expect(launcher.isMusl('linux', null, NO_LOADER)).toBe(false)
  expect(launcher.isMusl('darwin', { header: {} }, NO_LOADER)).toBe(false)
})

test('musl is found under Bun too', () => {
  expect(launcher.isMusl('linux', null, (p) => p === '/lib/ld-musl-x86_64.so.1')).toBe(true)
  expect(launcher.isMusl('linux', null, (p) => p === '/lib/ld-musl-aarch64.so.1')).toBe(true)
  expect(launcher.isMusl('linux', { header: { glibcVersionRuntime: '2.39' } }, () => false)).toBe(false)
  expect(launcher.isMusl('darwin', null, () => true)).toBe(false)
})

test('the report is read only on Linux', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'report')
  const bun = Object.getOwnPropertyDescriptor(process.versions, 'bun')
  let calls = 0
  let excludedAtCall: unknown
  const fake = {
    excludeNetwork: false,
    getReport() {
      calls++
      excludedAtCall = fake.excludeNetwork
      return { header: {} }
    },
  }
  Object.defineProperty(process, 'report', { value: fake, configurable: true })
  // Run as Node would: Bun's own report is deliberately never read.
  Object.defineProperty(process.versions, 'bun', { value: undefined, configurable: true })
  try {
    expect(launcher.currentReport('darwin')).toBeNull()
    expect(calls).toBe(0)
    expect(launcher.currentReport('linux')).toEqual({ header: {} })
    expect(calls).toBe(1)
    expect(excludedAtCall).toBe(true)
    Object.defineProperty(process.versions, 'bun', { value: '1.4.4', configurable: true })
    expect(launcher.currentReport('linux')).toBeNull()
    expect(calls).toBe(1)
  } finally {
    if (bun !== undefined) Object.defineProperty(process.versions, 'bun', bun)
    if (original !== undefined) Object.defineProperty(process, 'report', original)
    else delete (process as { report?: unknown }).report
  }
})

shellTest('linux musl prints the supported platforms and exits 1 even with the glibc package installed', async () => {
  const result = await launch({ platform: 'linux', arch: 'x64', packages: ['@kinfold/cli-linux-x64'], argv: ['status'], musl: true })

  expect(result.exitCode).toBe(1)
  expect(result.stderr).toBe(`kinfold: no build for linux-musl-x64. ${SUPPORTED}\n`)
})

describe('pack-npm', () => {
  function distWithPrograms(): { dir: string; programs: Map<string, Uint8Array> } {
    const dir = temp('kinfold-pack-')
    const programs = new Map<string, Uint8Array>()
    for (const target of NPM_TARGETS) {
      const bytes = new TextEncoder().encode(`program for ${target.target}\n`)
      writeFileSync(join(dir, target.program), bytes, { mode: 0o755 })
      programs.set(target.target, bytes)
    }
    return { dir, programs }
  }

  test('copies each program unchanged and writes five optional packages at one version', () => {
    const { dir, programs } = distWithPrograms()

    const summary = packNpm(dir, '1.4.0')

    expect(summary.map((entry) => entry.packageName)).toEqual(NPM_TARGETS.map((target) => target.packageName))
    const launcherManifest = JSON.parse(readFileSync(join(dir, 'npm', 'kinfold', 'package.json'), 'utf8')) as Record<string, unknown>
    expect(launcherManifest.name).toBe('kinfold')
    expect(launcherManifest.version).toBe('1.4.0')
    expect(launcherManifest.dependencies).toBeUndefined()
    expect(launcherManifest.devDependencies).toBeUndefined()
    expect(launcherManifest.optionalDependencies).toEqual(Object.fromEntries(NPM_TARGETS.map((target) => [target.packageName, '1.4.0'])))
    expect(Object.keys(launcherManifest.optionalDependencies as Record<string, string>)).toHaveLength(5)
    expect(readFileSync(join(dir, 'npm', 'kinfold', 'bin', 'kinfold.js'), 'utf8')).toBe(readFileSync(LAUNCHER_FILE, 'utf8'))

    for (const target of NPM_TARGETS) {
      const packageDir = join(dir, 'npm', target.dir)
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as Record<string, unknown>
      expect(manifest.name).toBe(target.packageName)
      expect(manifest.version).toBe('1.4.0')
      expect(manifest.os).toEqual([target.os])
      expect(manifest.cpu).toEqual([target.cpu])
      expect(manifest.libc).toEqual(target.os === 'linux' ? ['glibc'] : undefined)
      expect(manifest.files).toContain(target.file)
      expect(sha256(readFileSync(join(packageDir, target.file)))).toBe(sha256(programs.get(target.target)!))
    }
  })

  test('refuses a version and a dist before it writes packages', () => {
    const { dir } = distWithPrograms()

    expect(() => packNpm(dir, '')).toThrow()
    expect(() => packNpm(dir, '0.0.0-dev')).toThrow('development version')
    expect(existsSync(join(dir, 'npm'))).toBe(false)

    rmSync(join(dir, NPM_TARGETS[0]!.program))
    expect(() => packNpm(dir, '1.4.0')).toThrow()
    expect(existsSync(join(dir, 'npm'))).toBe(false)
  })
})
