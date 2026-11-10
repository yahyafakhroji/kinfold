// The Linux (WSL included) user service: a systemd user unit that runs the
// daemon the way the macOS LaunchAgent does. This file writes and reads the
// unit; until the user manager is driven, starting and stopping refuse.

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { envName } from '../../env-names'
import { notSupportedYet } from '../../platform/platform'
import { entryCommand } from '../entry'
import type { InstallEnv } from '../env'
import { launchdPath } from '../launch-agent'
import type { ServiceControl, ServiceStep } from './control'
import { NOT_SET_UP_REASON } from './stub-service'

export const SYSTEMD_UNIT = 'kinfold.service'
const LABEL = 'systemd user service'
const MAX_PORT = 65_535
// A newline would end the assignment early and let the rest of the value
// become a line of its own; no quoting form carries one.
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/

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
  refuseControl(env.dataDir, 'the data folder')
  refuseControl(env.homeDir, 'the home folder')
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

  constructor(private readonly env: InstallEnv) {}

  private get unitPath(): string {
    return join(systemdUserDir(this.env), SYSTEMD_UNIT)
  }

  isConfigured(): boolean {
    return existsSync(this.unitPath)
  }

  async isRunning(): Promise<boolean> {
    return false
  }

  async start(): Promise<void> {
    throw new Error(notSupportedYet(this.label))
  }

  async stop(): Promise<void> {
    throw new Error(notSupportedYet(this.label))
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

  async fileHolders(_path: string): Promise<string> {
    return ''
  }

  configPath(): string {
    return this.unitPath
  }

  configContent(port: number): string {
    return unitContent(this.env, port)
  }

  describe(_step: ServiceStep): string {
    return notSupportedYet(this.label)
  }

  unavailableReason(): string | null {
    return NOT_SET_UP_REASON
  }
}
