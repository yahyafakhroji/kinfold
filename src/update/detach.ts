// How the daemon starts a program that must outlive it. The update stops the
// background service, and each service manager ends more than the daemon:
// launchd ends the job's process group, systemd ends the unit's whole cgroup,
// and on Windows a child sits in the parent's kill-on-close job. So the
// updater leaves each of those: its own process group on macOS, a transient
// unit of its own on Linux, and a detached process on Windows. The live test
// (detach.live.test.ts) proves each on a hosted runner, where a child started
// the plain way is gone after the stop and the detached one is not.

import { existsSync } from 'node:fs'
import type { OsName } from '../platform/platform'

type Env = Readonly<Record<string, string | undefined>>

export const SYSTEMD_RUN_CANDIDATES: readonly string[] = ['/usr/bin/systemd-run', '/bin/systemd-run']
export const NO_SYSTEMD_RUN = 'systemd-run is not installed, so an update started by the service would be stopped with it'

export type DetachPlan =
  | { ok: true; argv: string[]; via: 'process-group' | 'systemd-run' }
  | { ok: false; reason: string }

export interface DetachInput {
  os: OsName
  program: string
  args: readonly string[]
  envVars: Env
  /** Test seam; default fs.existsSync. */
  exists?: (path: string) => boolean
}

/** The transient unit starts with the user manager's environment, so the two variables install reads travel in argv. Neither is a secret. */
function systemdRunArgv(systemdRun: string, input: DetachInput): string[] {
  const carried = (['PATH', 'HOME'] as const).flatMap((name) => {
    const value = input.envVars[name]
    return value === undefined || value === '' ? [] : [`--setenv=${name}=${value}`]
  })
  // --collect: a failed run leaves no unit behind to block the next one.
  return [systemdRun, '--user', '--collect', '--quiet', '--description=Kinfold update', ...carried, '--', input.program, ...input.args]
}

function linuxPlan(input: DetachInput, exists: (path: string) => boolean): DetachPlan {
  const runtimeDir = input.envVars.XDG_RUNTIME_DIR
  // No user manager means no unit runs this daemon, so there is no cgroup to leave.
  const managed = runtimeDir !== undefined && runtimeDir !== '' && exists(`${runtimeDir}/systemd/private`)
  if (!managed) return { ok: true, via: 'process-group', argv: [input.program, ...input.args] }
  const systemdRun = SYSTEMD_RUN_CANDIDATES.find((path) => exists(path))
  if (systemdRun === undefined) return { ok: false, reason: NO_SYSTEMD_RUN }
  return { ok: true, via: 'systemd-run', argv: systemdRunArgv(systemdRun, input) }
}

export function detachPlan(input: DetachInput): DetachPlan {
  const exists = input.exists ?? existsSync
  switch (input.os) {
    case 'linux': return linuxPlan(input, exists)
    // Windows too starts the program itself. Under conhost --headless, as the scheduled task runs the daemon, a
    // program started from the daemon never ran; the spawn's hidden-window flag keeps a console from showing instead.
    case 'macos':
    case 'windows': return { ok: true, via: 'process-group', argv: [input.program, ...input.args] }
  }
}

export interface DetachedSpawnOptions {
  detached: true
  windowsHide: true
  stdin: 'ignore'
  stdout: 'ignore'
  stderr: 'ignore'
  env: Record<string, string>
}

export type SpawnDetachedFn = (argv: string[], options: DetachedSpawnOptions) => { pid: number; unref(): void }

const bunSpawn: SpawnDetachedFn = (argv, options) => Bun.spawn(argv, options)

/** Starts argv outside this process's group and job and does not wait for it; returns its pid. */
export function spawnDetached(argv: readonly string[], env: Env, spawn: SpawnDetachedFn = bunSpawn): number {
  const vars: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (typeof value === 'string') vars[key] = value
  // No pipe back to this process: the child must not get a broken pipe when the daemon stops.
  const child = spawn([...argv], { detached: true, windowsHide: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: vars })
  child.unref()
  return child.pid
}
