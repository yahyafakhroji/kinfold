// Linux runs the daemon as a systemd user service and keeps the database key in
// the Secret Service keyring (x64) or the key file (arm64); linux.sh setup says
// which through KINFOLD_SMOKE_KEY_STORE. A runner without a user manager falls
// back to a hand-started daemon (KINFOLD_SMOKE_SERVICE=foreground).
//
// The Linux lines of status go to the driver through statusLines. The driver
// has no hook for the installed unit, so runConversion checks it once, before
// the first conversion, and then hands every conversion to the driver's own
// pty run.

import { posix } from 'node:path'
import { runPty } from '../smoke'
import { SmokeError } from './platform'
import type { SmokePlatform, SmokeResult, SmokeWorld } from './platform'

const UNIT = 'kinfold.service'
const SERVICE_LABEL = 'systemd user service'
const DEFAULT_PORT = 37_811
const HEALTH_WAIT_MS = 60_000
const HEALTH_POLL_MS = 250
const HEALTH_REQUEST_MS = 2_000
const STOP_WAIT_MS = 20_000
const VERIFY_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 4_000

const KEY_STORES = ['libsecret', 'key file'] as const
const SERVICE_MODES = ['systemd', 'foreground'] as const
type ServiceMode = typeof SERVICE_MODES[number]

const KEY_STORE_ERROR = 'KINFOLD_SMOKE_KEY_STORE must be libsecret or key file; .github/smoke/linux.sh setup sets it'
const SERVICE_ERROR = 'KINFOLD_SMOKE_SERVICE must be systemd or foreground; .github/smoke/linux.sh setup sets it'

type Conversion = 'encrypt' | 'decrypt'
type ForegroundStart = (world: SmokeWorld) => Promise<{ stop(): Promise<void> }>

export interface LinuxSmokeDeps {
  /** Where the setup variables are read; default process.env. */
  env?: Readonly<Record<string, string | undefined>>
  /** `systemd-analyze --user verify <unit>`. */
  verifyUnit?: (world: SmokeWorld, unit: string) => Promise<SmokeResult>
  /** The pty conversion; default the driver's expect run. */
  runPty?: (world: SmokeWorld, operation: Conversion) => Promise<SmokeResult>
}

function cap(text: string): string {
  return text.length <= OUTPUT_LIMIT ? text : `${text.slice(0, OUTPUT_LIMIT)}<truncated>`
}

function unitPath(home: string): string {
  // The unit path is POSIX; posix.join keeps the answer the same when the
  // shared tests run on Windows.
  return posix.join(home, '.config', 'systemd', 'user', UNIT)
}

async function runCommand(argv: readonly string[], world: SmokeWorld, timeoutMs: number): Promise<SmokeResult> {
  const child = Bun.spawn([...argv], { cwd: world.project, env: world.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (timedOut) throw new SmokeError('timeout', `${argv.join(' ')} did not finish in ${timeoutMs} ms`)
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function expectedStatusLines(label: string, mode: ServiceMode): RegExp[] {
  const service = escapeRegExp(`service (${SERVICE_LABEL}): config `)
  return [
    new RegExp(`^key store: ${escapeRegExp(label)} \\(recorded in key-store\\.json\\)$`, 'm'),
    mode === 'systemd'
      ? new RegExp(`^${service}present; running: yes$`, 'm')
      // A hand-started daemon answers /health while the unit is not running.
      : new RegExp(`^${service}\\w+; running: no$`, 'm'),
    // A runner's disk is either a LUKS volume or not; a missing line means the
    // check could not read the mounts, which the smoke must notice.
    /^(disk encryption: .+|warning: LUKS is off; .+)$/m,
  ]
}

async function checkUnit(world: SmokeWorld, verify: NonNullable<LinuxSmokeDeps['verifyUnit']>): Promise<void> {
  const unit = unitPath(world.home)
  const result = await verify(world, unit)
  const output = `${result.stdout}\n${result.stderr}`.trim()
  // verify also reports on units this one pulls in, which the runner owns; a
  // line about this unit, or a failing exit, is the unit's own error.
  const own = output.split('\n').filter((line) => line.includes(UNIT))
  if (result.code !== 0 || own.length > 0) {
    throw new SmokeError('unit', `systemd-analyze --user verify ${unit} exited ${result.code}\n${cap(output)}`)
  }
  if (output !== '') process.stdout.write(`smoke: systemd-analyze notes about other units:\n${cap(output)}\n`)
}

type Child = ReturnType<typeof Bun.spawn>

async function waitForHealth(child: Child, port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS
  let exited = false
  void child.exited.then(() => { exited = true })
  for (;;) {
    if (exited) throw new SmokeError('daemon', `the foreground daemon exited ${child.exitCode} before /health answered`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_REQUEST_MS) })
      if (response.ok) return
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) throw new SmokeError('daemon', `the foreground daemon did not answer /health on 127.0.0.1:${port} within ${HEALTH_WAIT_MS} ms`)
    await Bun.sleep(HEALTH_POLL_MS)
  }
}

async function stopChild(child: Child): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(STOP_WAIT_MS).then(() => false)])
  if (stopped) return
  child.kill('SIGKILL')
  await child.exited
  throw new SmokeError('daemon', `the foreground daemon ignored SIGTERM for ${STOP_WAIT_MS} ms and was killed`)
}

function portOf(world: SmokeWorld): number {
  // The driver removes KINFOLD_PORT, so a real run always uses the default.
  const text = world.env.KINFOLD_PORT ?? ''
  return /^\d+$/.test(text) ? Number(text) : DEFAULT_PORT
}

const startForegroundDaemon: ForegroundStart = async (world) => {
  const program = posix.join(world.dataDir, 'bin', 'kinfold')
  // The daemon's output can hold event text, so it is not passed through.
  const child = Bun.spawn([program, '--data-dir', world.dataDir, 'daemon'], { cwd: world.project, env: world.env, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  try {
    await waitForHealth(child, portOf(world))
  } catch (error: unknown) {
    await stopChild(child).catch(() => {})
    throw error
  }
  return { stop: async () => await stopChild(child) }
}

function serviceModeOf(value: string | undefined): ServiceMode | null {
  return SERVICE_MODES.find((mode) => mode === value) ?? null
}

export function createLinuxPlatform(deps: LinuxSmokeDeps = {}): SmokePlatform {
  const env = deps.env ?? process.env
  // Read once, as the module loads: setup writes it before the smoke starts.
  const mode = serviceModeOf(env.KINFOLD_SMOKE_SERVICE)
  const verifyUnit = deps.verifyUnit ?? ((world: SmokeWorld, unit: string) => runCommand(['systemd-analyze', '--user', 'verify', unit], world, VERIFY_TIMEOUT_MS))
  const pty = deps.runPty ?? runPty
  const checked = new WeakSet<SmokeWorld>()

  const platform = {
    name: 'linux',
    programName: 'kinfold',
    get keyStoreLabel(): string {
      const value = env.KINFOLD_SMOKE_KEY_STORE
      const store = KEY_STORES.find((name) => name === value)
      if (store === undefined) throw new SmokeError('setup', KEY_STORE_ERROR)
      return store
    },
    serviceLoaded(childEnv: Readonly<Record<string, string>>): boolean {
      const result = Bun.spawnSync(['systemctl', '--user', 'is-active', '--quiet', UNIT], { env: { ...childEnv }, stdout: 'ignore', stderr: 'ignore' })
      return result.exitCode === 0
    },
    serviceFiles(home: string): string[] {
      return [unitPath(home)]
    },
    // Lazy, so importing this file never throws when setup has not run; the
    // driver reads it only after install.
    get foregroundDaemon(): ForegroundStart | undefined {
      if (mode === null) throw new SmokeError('setup', SERVICE_ERROR)
      return mode === 'foreground' ? startForegroundDaemon : undefined
    },
    statusLines(_world: SmokeWorld): RegExp[] {
      if (mode === null) throw new SmokeError('setup', SERVICE_ERROR)
      return expectedStatusLines(platform.keyStoreLabel, mode)
    },
    async runConversion(world: SmokeWorld, operation: Conversion): Promise<SmokeResult> {
      if (!checked.has(world)) {
        if (mode === null) throw new SmokeError('setup', SERVICE_ERROR)
        if (mode === 'systemd') await checkUnit(world, verifyUnit)
        checked.add(world)
      }
      return await pty(world, operation)
    },
  } satisfies SmokePlatform
  return platform
}

export const smokePlatform: SmokePlatform = createLinuxPlatform()
