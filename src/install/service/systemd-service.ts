// The Linux (WSL included) user service: a systemd user unit that runs the
// daemon the way the macOS LaunchAgent does. This file writes and reads the
// unit, drives it through `systemctl --user`, and reads /proc for who holds a
// file. Where no user manager is reachable (a container, WSL without systemd,
// a shell with no login session) it sets nothing up and runs no systemctl.

import { existsSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { envName } from '../../env-names'
import { entryCommand } from '../entry'
import type { CommandResult, InstallEnv } from '../env'
import { launchdPath } from '../launch-agent'
import type { ServiceControl, ServiceStep } from './control'
import { STOP_ATTEMPTS, STOP_RETRY_MS } from './launch-agent-service'

export const SYSTEMD_UNIT = 'kinfold.service'
const LABEL = 'systemd user service'
const MAX_PORT = 65_535
/** The lowest port the installer accepts; a unit never carries one it would refuse. */
const MIN_INSTALL_PORT = 1024
// A newline would end the assignment early and let the rest of the value
// become a line of its own; no quoting form carries one.
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/
const SYSTEMCTL_TIMEOUT_MS = 15_000
const ENV = '/usr/bin/env'

export const SYSTEMCTL_CANDIDATES: readonly string[] = ['/usr/bin/systemctl', '/bin/systemctl']

export interface SystemdOptions {
  /** Test seam; default the first existing SYSTEMCTL_CANDIDATES entry, else null. */
  systemctl?: string | null
  /** Test seam; default '/proc'. */
  procRoot?: string
}

export type UserManager = { reachable: true; runtimeDir: string; systemctl: string } | { reachable: false; reason: string }

/**
 * Whether `systemctl --user` can reach this user's manager. XDG_RUNTIME_DIR is
 * read from env.envVars only, so a test world never reaches a real manager;
 * the private socket under it exists only while the manager runs.
 */
export function userManagerOf(env: Pick<InstallEnv, 'envVars'>, systemctl: string | null): UserManager {
  const runtimeDir = env.envVars?.XDG_RUNTIME_DIR
  if (runtimeDir === undefined || runtimeDir === '') return { reachable: false, reason: 'XDG_RUNTIME_DIR is not set' }
  if (systemctl === null) return { reachable: false, reason: 'systemctl is not installed' }
  const socket = `${runtimeDir}/systemd/private`
  if (!existsSync(socket)) return { reachable: false, reason: `${socket} does not exist` }
  return { reachable: true, runtimeDir, systemctl }
}

/** The command runner gives children only PATH and HOME, so the runtime dir travels in argv. It is not a secret. */
export function systemctlArgv(manager: { runtimeDir: string; systemctl: string }, args: readonly string[]): string[] {
  return [ENV, `XDG_RUNTIME_DIR=${manager.runtimeDir}`, manager.systemctl, '--user', ...args]
}

/** True when some fd link under the folder points at target; an unreadable folder or link counts as none. */
function holdsFile(fdDir: string, target: string): boolean {
  let fds: string[]
  try {
    fds = readdirSync(fdDir)
  } catch {
    return false
  }
  return fds.some((fd) => {
    try {
      return readlinkSync(join(fdDir, fd)) === target
    } catch {
      return false
    }
  })
}

/** A process name for a message; another user's process picks its own, so control characters go. */
function commandName(pidDir: string): string {
  try {
    return readFileSync(join(pidDir, 'comm'), 'utf8').trim().replace(/[\x00-\x1f\x7f]/g, '?')
  } catch {
    return ''
  }
}

/**
 * `<pid> <comm>` for each process with the file open, joined by '; '. Reads
 * /proc rather than running lsof, which a minimal Linux often lacks; skips
 * this process and every entry it cannot read.
 */
export function procFileHolders(procRoot: string, path: string, selfPid: number): string {
  let target: string
  let pids: string[]
  try {
    target = realpathSync(path)
    pids = readdirSync(procRoot)
  } catch {
    return ''
  }
  const found: string[] = []
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === selfPid) continue
    const pidDir = join(procRoot, pid)
    if (!holdsFile(join(pidDir, 'fd'), target)) continue
    const name = commandName(pidDir)
    found.push(name === '' ? pid : `${pid} ${name}`)
  }
  return found.join('; ')
}

/** $XDG_CONFIG_HOME/systemd/user when it is absolute (the spec ignores a relative one), else ~/.config/systemd/user. */
export function systemdUserDir(env: Pick<InstallEnv, 'homeDir' | 'envVars'>): string {
  const configHome = env.envVars?.XDG_CONFIG_HOME
  const base = configHome !== undefined && configHome !== '' && isAbsolute(configHome) ? configHome : join(env.homeDir, '.config')
  return join(base, 'systemd', 'user')
}

function refuseControl(value: string, field: string): void {
  if (CONTROL_CHARACTER.test(value)) throw new Error(`${LABEL}: ${field} holds a control character and cannot go in a unit file`)
}

/** systemd expands % specifiers in nearly every setting, so a literal % is doubled. */
function escapePercent(value: string, field: string): string {
  refuseControl(value, field)
  return value.replace(/%/g, '%%')
}

/**
 * One quoted unit-file word; exec also doubles `$`, which ExecStart= would
 * otherwise expand as a variable. Throws on a control character.
 */
export function systemdQuote(value: string, options: { exec?: boolean; field?: string } = {}): string {
  refuseControl(value, options.field ?? 'a value')
  const escaped = value.replace(/[\\"%$]/g, (char) => {
    if (char === '%') return '%%'
    if (char === '$') return options.exec === true ? '$$' : '$'
    return `\\${char}`
  })
  return `"${escaped}"`
}

const assignment = (name: string, value: string, field: string): string => `Environment=${systemdQuote(`${name}=${value}`, { field })}`

/**
 * The port goes in only when it is not the default, so an install that keeps
 * 37811 writes the same unit it always did. Each Environment= line holds one
 * assignment, so unitEnvironment reads back exactly what this writes.
 */
export function unitContent(env: Pick<InstallEnv, 'mode' | 'pathEnv' | 'homeDir' | 'dataDir' | 'envVars'>, port: number): string {
  // The named fields first, so a bad data folder is reported as one rather than as a daemon argument.
  // WorkingDirectory= is unquoted: a trailing backslash joins the next line
  // into it and trailing whitespace is stripped, so either would point the
  // daemon somewhere other than KINFOLD_DATA_DIR.
  if (/[\\\s]$/.test(env.dataDir)) throw new Error(`${LABEL}: the data folder ends in a backslash or a space and cannot go in a unit file`)
  refuseControl(env.dataDir, 'the data folder')
  refuseControl(env.homeDir, 'the home folder')
  if (!Number.isInteger(port) || port < MIN_INSTALL_PORT || port > MAX_PORT) throw new Error(`${LABEL}: the port must be a whole number from ${MIN_INSTALL_PORT} to ${MAX_PORT}`)
  const daemon = entryCommand(env.mode, 'daemon', env.dataDir)
  const exec = [systemdQuote(daemon.command, { exec: true, field: 'the program path' }), ...daemon.args.map((arg) => systemdQuote(arg, { exec: true, field: 'a daemon argument' }))]
  const dataDir = escapePercent(env.dataDir, 'the data folder')
  const logFile = escapePercent(join(env.dataDir, 'logs', 'daemon.log'), 'the log file')
  const portLine = port === DEFAULT_PORT ? [] : [assignment(envName('PORT'), String(port), 'the port')]
  return [
    '# Written by kinfold install; kinfold uninstall removes it.',
    '[Unit]',
    'Description=Kinfold memory daemon',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${exec.join(' ')}`,
    `WorkingDirectory=${dataDir}`,
    assignment(envName('DATA_DIR'), env.dataDir, 'the data folder'),
    assignment('PATH', launchdPath({ bunPath: daemon.command, pathEnv: env.pathEnv }), 'PATH'),
    assignment('HOME', env.homeDir, 'the home folder'),
    ...portLine,
    `StandardOutput=append:${logFile}`,
    `StandardError=append:${logFile}`,
    'UMask=0077',
    'Restart=always',
    'RestartSec=2',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/** The one quoted word systemdQuote wrote, unescaped; null when the text is not one. */
function unquoteWord(text: string): string | null {
  if (!text.startsWith('"')) return null
  let value = ''
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index]
    if (char === '"') return text.slice(index + 1).trim() === '' ? value : null
    if (char === '\\') {
      index += 1
      if (index >= text.length) return null
      value += text[index]
    } else if (char === '%' && text[index + 1] === '%') {
      index += 1
      value += '%'
    } else {
      value += char
    }
  }
  return null
}

/** The Environment= assignments this file writes, unquoted. */
export function unitEnvironment(text: string): Map<string, string> {
  const found = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('Environment=')) continue
    const word = unquoteWord(line.slice('Environment='.length))
    if (word === null) continue
    const equals = word.indexOf('=')
    if (equals <= 0) continue
    found.set(word.slice(0, equals), word.slice(equals + 1))
  }
  return found
}

export class SystemdUserService implements ServiceControl {
  readonly label = LABEL
  private readonly systemctl: string | null
  private readonly procRoot: string

  constructor(private readonly env: InstallEnv, options: SystemdOptions = {}) {
    this.systemctl = options.systemctl !== undefined ? options.systemctl : SYSTEMCTL_CANDIDATES.find((path) => existsSync(path)) ?? null
    this.procRoot = options.procRoot ?? '/proc'
  }

  private get unitPath(): string {
    return join(systemdUserDir(this.env), SYSTEMD_UNIT)
  }

  private manager(): UserManager {
    return userManagerOf(this.env, this.systemctl)
  }

  private reachableManager(): { runtimeDir: string; systemctl: string } {
    const manager = this.manager()
    if (!manager.reachable) throw new Error(`${LABEL}: no user service manager is reachable (${manager.reason})`)
    return manager
  }

  private call(manager: { runtimeDir: string; systemctl: string }, args: readonly string[]): Promise<CommandResult> {
    return this.env.run({ argv: systemctlArgv(manager, args), timeoutMs: SYSTEMCTL_TIMEOUT_MS })
  }

  /** Never quotes systemctl's output: a unit's status can carry environment values. */
  private async mustCall(manager: { runtimeDir: string; systemctl: string }, args: readonly string[]): Promise<CommandResult> {
    const result = await this.call(manager, args)
    if (result.exitCode !== 0 || result.timedOut === true) throw new Error(`${LABEL}: systemctl --user ${args.join(' ')} failed (exit ${result.exitCode})`)
    return result
  }

  private async isActive(manager: { runtimeDir: string; systemctl: string }): Promise<boolean> {
    const result = await this.call(manager, ['is-active', '--quiet', SYSTEMD_UNIT])
    return result.exitCode === 0 && result.timedOut !== true
  }

  isConfigured(): boolean {
    return existsSync(this.unitPath)
  }

  async isRunning(): Promise<boolean> {
    const manager = this.manager()
    return manager.reachable && (await this.isActive(manager))
  }

  async start(): Promise<void> {
    const manager = this.reachableManager()
    await this.mustCall(manager, ['daemon-reload'])
    // A unit written where this manager does not look would make enable fail
    // with a message about a missing unit; this names the likely cause.
    const shown = await this.mustCall(manager, ['show', '--property=LoadState', '--value', SYSTEMD_UNIT])
    if (shown.stdout.trim() !== 'loaded') {
      throw new Error(`${LABEL}: the user manager did not load ${this.unitPath}; it reads units from another config folder (check XDG_CONFIG_HOME). Nothing was started`)
    }
    await this.mustCall(manager, ['enable', '--now', SYSTEMD_UNIT])
  }

  /** disable --now also drops the default.target.wants link, so uninstall leaves none behind. */
  async stop(): Promise<void> {
    const manager = this.reachableManager()
    const { exitCode } = await this.call(manager, ['disable', '--now', SYSTEMD_UNIT])
    for (let attempt = 1; await this.isActive(manager); attempt += 1) {
      if (attempt >= STOP_ATTEMPTS) throw new Error(`the ${LABEL} is still active after disable --now (exit ${exitCode})`)
      await this.env.sleep(STOP_RETRY_MS)
    }
  }

  private readEnvironment(): Map<string, string> | null {
    try {
      return unitEnvironment(readFileSync(this.unitPath, 'utf8'))
    } catch {
      return null
    }
  }

  configuredDataDir(): string | null {
    const value = this.readEnvironment()?.get(envName('DATA_DIR'))
    return value === undefined || value === '' ? null : value
  }

  configuredPort(): number | null {
    const value = this.readEnvironment()?.get(envName('PORT'))
    if (value === undefined || !/^\d+$/.test(value)) return null
    const port = Number(value)
    return port >= 1 && port <= MAX_PORT ? port : null
  }

  async fileHolders(path: string): Promise<string> {
    return procFileHolders(this.procRoot, path, process.pid)
  }

  /** No unit is written where no manager could load it. */
  configPath(): string | null {
    return this.manager().reachable ? this.unitPath : null
  }

  configContent(port: number): string | null {
    return this.configPath() === null ? null : unitContent(this.env, port)
  }

  describe(step: ServiceStep): string {
    return step === 'start'
      ? `${LABEL}: systemctl --user daemon-reload, then systemctl --user enable --now ${SYSTEMD_UNIT}`
      : `${LABEL}: systemctl --user disable --now ${SYSTEMD_UNIT}`
  }

  unavailableReason(): string | null {
    const manager = this.manager()
    return manager.reachable ? null : `no user service manager is reachable (${manager.reason})`
  }
}
