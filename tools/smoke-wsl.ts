// The WSL smoke's driver (the checks live in tools/smoke/wsl.ts). It installs
// the Windows build into the runner's own home, then runs the Linux build in
// an Ubuntu distro the workflow has set up, and finally uninstalls on Windows.
// It writes to the runner's home, Task Scheduler and Credential Manager, so it
// refuses to run anywhere but a GitHub Actions Windows runner.
//
// Usage: bun tools/smoke-wsl.ts <windows program> <linux program> <distro>

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { QUARANTINE_DIR } from '../src/resources/spool/spool'
import { sumsUrl } from './smoke-sums-url'
import { SmokeError, type SmokeResult } from './smoke/platform'
import { distroArgv, expectNatRefusal, expectNotLinked, hookPayload, sessionEventCount } from './smoke/wsl'

const COMMAND_TIMEOUT_MS = 240_000
const INGEST_TIMEOUT_MS = 60_000
const POLL_MS = 1_000
const OUTPUT_LIMIT = 6_000
/** Where the Linux build is copied inside the distro: its own disk, since a program started from /mnt/c is slow. */
const DISTRO_PROGRAM = '/root/kinfold'

/** What every program run gets: install checks a release candidate against the local SHA256SUMS this names. */
let runEnv: Record<string, string | undefined> = process.env

async function run(argv: readonly string[], stdin?: string): Promise<SmokeResult> {
  const child = Bun.spawn([...argv], { env: runEnv, stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin), stdout: 'pipe', stderr: 'pipe' })
  const timer = setTimeout(() => child.kill(), COMMAND_TIMEOUT_MS)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function shown(result: SmokeResult): string {
  const text = `exit ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}<truncated>`
}

function expectOk(step: string, result: SmokeResult): void {
  if (result.code !== 0) throw new SmokeError(step, shown(result))
}

function say(line: string): void {
  process.stdout.write(`smoke-wsl: ${line}\n`)
}

async function windowsInstall(program: string): Promise<number> {
  say('install on Windows')
  expectOk('windows install', await run([program, 'install', '--yes', '--hosts', 'zed', '--observer', 'zed=off', '--skip-check', '--no-update-check', '--no-path']))
  const status = await run([program, 'status'])
  expectOk('windows status', status)
  const port = /daemon \/health: up on 127\.0\.0\.1:(\d+)/.exec(status.stdout)?.[1]
  if (port === undefined) throw new SmokeError('windows status', `the Windows daemon is not up\n${shown(status)}`)
  return Number(port)
}

async function toDistroPath(distro: string, windowsPath: string): Promise<string> {
  const converted = await run(distroArgv(distro, ['wslpath', '-u', windowsPath]))
  expectOk('wslpath', converted)
  return converted.stdout.trim()
}

async function distroChecks(distro: string, linuxProgram: string, port: number): Promise<void> {
  say('copy the Linux build into the distro')
  expectOk('copy', await run(distroArgv(distro, ['install', '-m', '0755', await toDistroPath(distro, linuxProgram), DISTRO_PROGRAM])))

  say('status in the distro')
  const status = await run(distroArgv(distro, [DISTRO_PROGRAM, 'status']))
  expectNotLinked(status)

  say('install in the distro refuses under NAT')
  expectNatRefusal(await run(distroArgv(distro, [DISTRO_PROGRAM, 'install', '--yes', '--hosts', 'claude-code'])), port)
  const untouched = await run(distroArgv(distro, ['sh', '-c', 'test ! -e /root/.kinfold-wsl && test ! -e /root/.kinfold && test ! -e /root/.claude/settings.json']))
  if (untouched.code !== 0) throw new SmokeError('wsl install', 'the refused install left files in the distro home')
}

/** The Windows daemon's sessions, read with its own token the way a local client reads them; any answer but 200 is an error, since a wrong token or a failing route would never turn into an ingest. */
async function sessions(dataDir: string, port: number): Promise<unknown> {
  const token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()
  const response = await fetch(`http://127.0.0.1:${port}/sessions`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5_000) })
  if (!response.ok) throw new SmokeError('wsl hook', `the Windows daemon answered /sessions with ${response.status}`)
  return await response.json()
}

async function distroHook(distro: string, dataDir: string, port: number): Promise<void> {
  say('a hook in the distro spools into the Windows folder')
  const marker = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const hook = await run(distroArgv(distro, [DISTRO_PROGRAM, '--data-dir', await toDistroPath(distro, dataDir), 'hook', '--host', 'claude-code']), `${hookPayload(marker)}\n`)
  expectOk('wsl hook', hook)
  say('the Windows daemon ingests it')
  const deadline = Date.now() + INGEST_TIMEOUT_MS
  for (;;) {
    const count = sessionEventCount(await sessions(dataDir, port), `wsl-${marker}`)
    if (count !== null && count >= 1) break
    if (Date.now() >= deadline) throw new SmokeError('wsl hook', `the Windows daemon did not ingest the distro's event within ${INGEST_TIMEOUT_MS} ms\n${shown(hook)}`)
    await Bun.sleep(POLL_MS)
  }
  const quarantine = join(dataDir, 'spool', QUARANTINE_DIR)
  const held = existsSync(quarantine) ? readdirSync(quarantine) : []
  if (held.length > 0) throw new SmokeError('wsl hook', `the Windows daemon quarantined ${held.join(', ')}`)
}

async function main(): Promise<void> {
  const [windowsProgram, linuxProgram, distro] = process.argv.slice(2)
  if (windowsProgram === undefined || linuxProgram === undefined || distro === undefined) {
    throw new SmokeError('setup', 'usage: bun tools/smoke-wsl.ts <windows program> <linux program> <distro>')
  }
  if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'win32') {
    throw new SmokeError('setup', 'the WSL smoke installs into the real home; it only runs on a GitHub Actions Windows runner')
  }
  const program = resolve(windowsProgram)
  const sums = join(dirname(program), 'SHA256SUMS')
  if (!existsSync(sums)) throw new SmokeError('setup', `${sums} is missing; install checks the program against it`)
  runEnv = { ...process.env, KINFOLD_RELEASE_SUMS_URL: sumsUrl(sums) }
  const dataDir = join(homedir(), '.kinfold')
  const port = await windowsInstall(program)
  let uninstalled: SmokeResult | null = null
  try {
    await distroChecks(distro, resolve(linuxProgram), port)
    await distroHook(distro, dataDir, port)
  } finally {
    say('uninstall on Windows')
    uninstalled = await run([program, 'uninstall', '--remove-credentials', '--remove-hmac-keys'])
    // A failure above is the one to report; the uninstall's own shows when everything else passed.
    if (uninstalled.code !== 0) say(`uninstall exited ${uninstalled.code}\n${shown(uninstalled)}`)
  }
  expectOk('windows uninstall', uninstalled)
  say('passed')
}

if (import.meta.main) {
  try {
    await main()
  } catch (error: unknown) {
    const step = error instanceof SmokeError ? error.step : 'error'
    process.stderr.write(`smoke-wsl failed at ${step}: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
