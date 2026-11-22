// How a WSL distro finds the Kinfold install on its Windows side, and whether
// that install's daemon answers from here. Windows is asked through interop:
// powershell.exe names the local app data folder, where the scheduled task's
// config sits outside the data folder, so this distro needs to know nothing
// else. Every command runs by absolute path through env.run.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { powershellArgv } from '../install/access/windows-acl'
import { checkHealth, readDaemonInfo } from '../install/daemon-client'
import type { InstallEnv } from '../install/env'
import { readTextOrNull } from '../install/files'
import { TASK_CONFIG_FILE, taskDataDir } from '../install/service/scheduled-task-service'
import { INSTALL_RECORD_FILE } from '../install/setup/record'
import { DAEMON_INFO_FILE } from '../store/data-dir'
import type { WslLink } from './link'
import { parseNetworkingMode } from './wsl-probes'

export const LINK_HEALTH_TIMEOUT_MS = 2_000
/** powershell.exe can take a few seconds to start the first time after logon. */
const INTEROP_TIMEOUT_MS = 15_000
const NOT_FOUND_EXIT = 127
export const WSLPATH = '/usr/bin/wslpath'
export const WSLINFO = '/usr/bin/wslinfo'
const KINFOLD_FOLDER = 'Kinfold'

/** Without a BOM, so the path reads back as written; the default code page would mangle a name like José. */
const LOCAL_APP_DATA_SCRIPT = [
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "[Environment]::GetFolderPath('LocalApplicationData')",
].join('\n')

export const INTEROP_OFF = 'Windows interop is off in this distro'

export type WindowsInstallFind =
  | { kind: 'found'; link: Omit<WslLink, 'linkedAt'> }
  | { kind: 'none'; reason: string }

export type WindowsDaemonHealth = { up: true; port: number; version: string } | { up: false; port: number | null; reason: string }

/**
 * C:\Windows\... as /mnt/c/Windows/..., for a Windows tool's own path. Only the
 * default /mnt automount root is known here; a distro that moved it is not
 * supported in the preview.
 */
export function windowsToolPath(windowsPath: string): string {
  const match = /^([A-Za-z]):\\(.*)$/.exec(windowsPath)
  if (match === null) return windowsPath
  return `/mnt/${(match[1] ?? '').toLowerCase()}/${(match[2] ?? '').replace(/\\/g, '/')}`
}

function firstLine(stdout: string): string {
  return stdout.replace(/^\uFEFF/, '').split(/\r?\n/)[0]?.trim() ?? ''
}

type Step = { ok: true; value: string } | { ok: false; reason: string }

async function localAppData(env: InstallEnv): Promise<Step> {
  const [program, ...args] = powershellArgv(env, LOCAL_APP_DATA_SCRIPT)
  const result = await env.run({ argv: [windowsToolPath(program ?? ''), ...args], timeoutMs: INTEROP_TIMEOUT_MS })
  if (result.exitCode === NOT_FOUND_EXIT) return { ok: false, reason: INTEROP_OFF }
  const path = firstLine(result.stdout)
  if (result.exitCode !== 0 || result.timedOut === true || path === '') {
    return { ok: false, reason: `powershell.exe did not name the Windows local app data folder (exit ${result.exitCode})` }
  }
  return { ok: true, value: path }
}

async function toWslPath(env: InstallEnv, windowsPath: string): Promise<Step> {
  const result = await env.run({ argv: [WSLPATH, '-u', windowsPath], timeoutMs: INTEROP_TIMEOUT_MS })
  const path = firstLine(result.stdout)
  if (result.exitCode !== 0 || result.timedOut === true || path === '') return { ok: false, reason: `wslpath could not convert ${windowsPath} (exit ${result.exitCode})` }
  return { ok: true, value: path }
}

export async function findWindowsInstall(env: InstallEnv): Promise<WindowsInstallFind> {
  const appData = await localAppData(env)
  if (!appData.ok) return { kind: 'none', reason: appData.reason }
  const appDataDir = await toWslPath(env, appData.value)
  if (!appDataDir.ok) return { kind: 'none', reason: appDataDir.reason }
  const taskConfig = join(appDataDir.value, KINFOLD_FOLDER, TASK_CONFIG_FILE)
  // The task file is UTF-16LE (schtasks reads no other); readTextOrNull decodes either.
  const xml = readTextOrNull(taskConfig)
  if (xml === null) return { kind: 'none', reason: `no Kinfold scheduled task config at ${taskConfig}` }
  const windowsDataDir = taskDataDir(xml)
  if (windowsDataDir === null) return { kind: 'none', reason: `the scheduled task config at ${taskConfig} names no data folder` }
  const dataDir = await toWslPath(env, windowsDataDir)
  if (!dataDir.ok) return { kind: 'none', reason: dataDir.reason }
  if (!existsSync(join(dataDir.value, INSTALL_RECORD_FILE))) return { kind: 'none', reason: `the scheduled task names ${windowsDataDir}, which has no install.json` }
  return { kind: 'found', link: { windowsDataDir, dataDir: dataDir.value, taskConfig } }
}

export async function networkingMode(env: InstallEnv): Promise<'mirrored' | 'nat' | 'unknown'> {
  try {
    const result = await env.run({ argv: [WSLINFO, '--networking-mode'], timeoutMs: INTEROP_TIMEOUT_MS })
    if (result.exitCode !== 0) return 'unknown'
    const mode = parseNetworkingMode(result.stdout)
    return mode === 'mirrored' || mode === 'nat' ? mode : 'unknown'
  } catch {
    return 'unknown'
  }
}

function timeout(ms: number): { promise: Promise<null>; clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return { promise, clear: () => clearTimeout(timer) }
}

/**
 * /health on the port the Windows daemon.json names, from this distro. A
 * daemon that answers with a pid other than daemon.json's is some other
 * program on a reused port, so it counts as not answering.
 */
export async function windowsDaemonHealth(env: InstallEnv, dataDir: string): Promise<WindowsDaemonHealth> {
  if (!existsSync(join(dataDir, DAEMON_INFO_FILE))) return { up: false, port: null, reason: `no ${DAEMON_INFO_FILE} in ${dataDir}` }
  const info = readDaemonInfo(dataDir)
  const limit = timeout(LINK_HEALTH_TIMEOUT_MS)
  try {
    const health = await Promise.race([checkHealth(env, info.port), limit.promise])
    if (health === null) return { up: false, port: info.port, reason: `no answer within ${LINK_HEALTH_TIMEOUT_MS} ms` }
    if (!health.up) return { up: false, port: info.port, reason: health.reason }
    if (info.pid !== null && health.pid !== undefined && health.pid !== info.pid) {
      return { up: false, port: info.port, reason: `pid ${health.pid} answers, not the daemon's pid ${info.pid}` }
    }
    return { up: true, port: info.port, version: health.version }
  } finally {
    limit.clear()
  }
}
