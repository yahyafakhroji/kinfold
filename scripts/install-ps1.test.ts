import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { windowsOnly } from '../test/platform-guards'

const INSTALL_PS1 = join(import.meta.dir, 'install.ps1')
const PWSH = Bun.which('pwsh')
const pwshTest = test.skipIf(PWSH === null)
const BASE_REFUSAL =
  'kinfold: KINFOLD_RELEASE_BASE must be http://127.0.0.1 with an optional port and path, or a file:// URL with an absolute path'
// pwsh can take several seconds to start on a cold runner.
const PWSH_TIMEOUT_MS = 45_000
const TEST_TIMEOUT_MS = 60_000

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

interface Run {
  code: number | null
  stdout: string
  stderr: string
  /** The install folders the script left in its temp folder. */
  tempEntries: string[]
}

/** Runs pwsh with its temp folder pointed at a fresh empty one and no inherited KINFOLD_* settings. */
function runPwsh(args: string[], vars: Record<string, string>): Run {
  const tempDir = temp('kinfold-ps1-tmp-')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || key.startsWith('KINFOLD_') || key === 'PROCESSOR_ARCHITEW6432') continue
    env[key] = value
  }
  Object.assign(env, { TMPDIR: tempDir, TEMP: tempDir, TMP: tempDir, POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }, vars)
  const result = Bun.spawnSync([PWSH!, '-NoProfile', '-NonInteractive', ...args], { env, stdout: 'pipe', stderr: 'pipe', timeout: PWSH_TIMEOUT_MS })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    tempEntries: readdirSync(tempDir).filter((name) => name.startsWith('kinfold-install-')),
  }
}

function pipedIntoIex(vars: Record<string, string>): Run {
  const script = INSTALL_PS1.replaceAll("'", "''")
  return runPwsh(['-Command', `Get-Content -Raw -LiteralPath '${script}' | Invoke-Expression; 'still-here'; $LASTEXITCODE`], vars)
}

const outputLines = (stdout: string) => stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

pwshTest('irm | iex keeps the session open', () => {
  const run = pipedIntoIex({ PROCESSOR_ARCHITECTURE: 'ARM64' })
  expect(outputLines(run.stdout)).toEqual(['still-here', '1'])
  expect(count(run.stderr, 'kinfold: no build for win32-arm64.')).toBe(1)
}, TEST_TIMEOUT_MS)

pwshTest('iex leaves the session\'s own functions and settings alone', () => {
  const script = INSTALL_PS1.replaceAll("'", "''")
  const run = runPwsh(['-Command', `Get-Content -Raw -LiteralPath '${script}' | Invoke-Expression; $ErrorActionPreference; [bool](Get-Command Fail -ErrorAction SilentlyContinue)`], { PROCESSOR_ARCHITECTURE: 'ARM64' })
  expect(outputLines(run.stdout)).toEqual(['Continue', 'False'])
}, TEST_TIMEOUT_MS)

pwshTest('a file run still exits with the code', () => {
  const run = runPwsh(['-File', INSTALL_PS1], { PROCESSOR_ARCHITECTURE: 'ARM64' })
  expect(run.code).toBe(1)
  expect(count(run.stderr, 'kinfold: no build for win32-arm64.')).toBe(1)
}, TEST_TIMEOUT_MS)

const REFUSED_BASES = ['http://127.0.0.1.evil.com', 'http://127.0.0.10', 'http://127.0.0.1@evil.com', 'HTTP://127.0.0.1', 'file:///']
const ACCEPTED_BASES = ['http://127.0.0.1:8080/r', 'file:///C:/rel/']

pwshTest('local bases are checked as whole origins', () => {
  for (const base of REFUSED_BASES) {
    const run = runPwsh(['-File', INSTALL_PS1], { PROCESSOR_ARCHITECTURE: 'AMD64', KINFOLD_RELEASE_BASE: base })
    expect({ base, code: run.code, stderr: run.stderr.trim() }).toEqual({ base, code: 1, stderr: BASE_REFUSAL })
    expect(run.tempEntries).toEqual([])
  }
  for (const base of ACCEPTED_BASES) {
    // Nothing serves these, so the download fails; the point is that the base check let them through.
    const run = runPwsh(['-File', INSTALL_PS1], { PROCESSOR_ARCHITECTURE: 'AMD64', KINFOLD_RELEASE_BASE: base })
    expect({ base, refused: run.stderr.includes(BASE_REFUSAL) }).toEqual({ base, refused: false })
    expect(run.code).not.toBe(0)
    expect(run.tempEntries).toEqual([])
  }
}, TEST_TIMEOUT_MS * 4)

windowsOnly('powershell child')("the program's exit code comes back under iex", () => {
  const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe')
  const release = temp('kinfold-ps1-release-')
  const asset = 'kinfold-windows-x64.exe'
  copyFileSync(whoami, join(release, asset))
  const hash = createHash('sha256').update(readFileSync(join(release, asset))).digest('hex')
  writeFileSync(join(release, 'SHA256SUMS'), `${hash}  ${asset}\n`)
  const expected = Bun.spawnSync([whoami, 'install'], { stdout: 'ignore', stderr: 'ignore' }).exitCode
  expect(expected).not.toBe(0)

  const run = pipedIntoIex({ PROCESSOR_ARCHITECTURE: 'AMD64', KINFOLD_RELEASE_BASE: pathToFileURL(release).href })
  expect(outputLines(run.stdout).slice(-2)).toEqual(['still-here', String(expected)])
  expect(run.tempEntries).toEqual([])
}, TEST_TIMEOUT_MS)
