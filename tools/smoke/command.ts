// The smoke's proof that install leaves a `kinfold` command behind, and that
// uninstall takes it away again. A child of the smoke inherits the smoke's
// PATH, which says nothing about a terminal opened later, so each OS starts
// the kind of shell a person would open next: a login, interactive shell from
// an empty environment on macOS and Linux, and on Windows a PowerShell whose
// PATH is rebuilt from the registry.

import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SmokeResult, SmokeWorld } from './platform'

const NEW_SHELL_TIMEOUT_MS = 60_000
const BLOCK_START = '# >>> kinfold >>>'
const STARTUP_FILES = ['.zshrc', '.bashrc', '.bash_profile']

/** Nothing of the smoke's environment reaches the shell: only its own startup files can put kinfold on PATH. */
export function newShellArgv(shell: string, home: string): string[] {
  return ['/usr/bin/env', '-i', `HOME=${home}`, 'PATH=/usr/bin:/bin:/usr/sbin:/sbin', 'TERM=dumb', shell, '-lic', 'kinfold --version']
}

export async function capture(argv: readonly string[], cwd: string, env: Record<string, string>): Promise<SmokeResult> {
  const child = Bun.spawn([...argv], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), NEW_SHELL_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `kinfold --version` from a new login shell. It first checks that install
 * wrote its block to `startupFile`, so a runner image that happens to put
 * ~/.local/bin on PATH itself cannot pass for it.
 */
export async function versionInNewShell(world: SmokeWorld, shell: string, startupFile: string): Promise<SmokeResult> {
  const path = join(world.home, startupFile)
  if (!existsSync(path) || !readFileSync(path, 'utf8').includes(BLOCK_START)) {
    return { code: 1, stdout: '', stderr: `${path} does not hold the kinfold PATH block` }
  }
  return await capture(newShellArgv(shell, world.home), world.project, {})
}

/** What uninstall left of the command in `home`, one line each. */
export function posixLeftovers(home: string): string[] {
  const link = join(home, '.local', 'bin', 'kinfold')
  let linked = false
  try {
    lstatSync(link)
    linked = true
  } catch {
    linked = false
  }
  const blocks = STARTUP_FILES.map((name) => join(home, name)).filter((path) => existsSync(path) && readFileSync(path, 'utf8').includes(BLOCK_START))
  return [...(linked ? [`${link} is still there`] : []), ...blocks.map((path) => `${path} still holds the kinfold PATH block`)]
}

const REGISTRY_PATH = "[Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')"

/** A terminal opened after install builds its PATH from the registry; this one does the same by hand. */
export function windowsNewShellScript(): string {
  return `$env:Path = ${REGISTRY_PATH}; kinfold --version; exit $LASTEXITCODE`
}

/** Prints the user PATH as the registry holds it. */
export function windowsLeftoversScript(): string {
  return "[Environment]::GetEnvironmentVariable('Path', 'User')"
}
