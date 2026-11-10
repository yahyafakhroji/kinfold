// The Windows service behind ServiceControl: a per-user scheduled task that
// starts the daemon at logon, registered and removed through schtasks.exe.
// schtasks prints localized text, so only exit codes are read; whether the
// daemon runs comes from the pid in daemon.json, checked against /health.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { checkHealth, readDaemonInfo } from '../daemon-client'
import { decodeText } from '../files'
import type { InstallEnv } from '../env'
import { HEALTH_WAIT_MS } from '../plan'
import { windowsJoin, windowsSystemTool } from '../windows-system-path'
import type { ServiceControl, ServiceStep } from './control'

export const TASK_NAME = 'KinfoldDaemon'
/** In <LOCALAPPDATA>\Kinfold: outside the data folder, so WSL can find it without knowing that folder. */
export const TASK_CONFIG_FILE = 'kinfold-daemon.xml'
export const STOP_POLL_MS = 250
const SCHTASKS_TIMEOUT_MS = 15_000
const MAX_PORT = 65_535
const NO_USERNAME = 'USERNAME is not set, so the task cannot name its user'
/** The checkout's CLI entry, which takes `--data-dir` and `daemon` the way the program does. */
const CHECKOUT_CLI = 'src/cli/kinfold.ts'

export interface TaskXmlInput {
  user: string
  program: string
  /** A script the program runs first: the checkout's CLI under bun. Absent for the installed program. */
  script?: string
  dataDir: string
  port: number
  logFile: string
}

export interface TaskProcessDeps {
  pidAlive(pid: number): boolean
  kill(pid: number): void
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

const processDeps: TaskProcessDeps = {
  pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error: unknown) {
      // EPERM: the pid exists but belongs to someone we may not signal.
      return errorCode(error) === 'EPERM'
    }
  },
  kill(pid) {
    try {
      process.kill(pid)
    } catch (error: unknown) {
      // ESRCH: it exited between the last poll and now, which is what stop wanted.
      if (errorCode(error) !== 'ESRCH') throw error
    }
  },
}

export function taskConfigPath(env: Pick<InstallEnv, 'homeDir' | 'envVars'>): string {
  const localAppData = env.envVars?.LOCALAPPDATA
  const base = localAppData !== undefined && localAppData !== '' ? localAppData : windowsJoin(env.homeDir, 'AppData', 'Local')
  return windowsJoin(base, 'Kinfold', TASK_CONFIG_FILE)
}

function schtasksPath(env: Pick<InstallEnv, 'envVars'>): string {
  return windowsSystemTool(env, 'System32\\schtasks.exe')
}

/** CommandLineToArgvW quoting: quotes when needed, doubles backslashes before a quote and at the end. */
export function windowsArg(value: string): string {
  if (value !== '' && !/[\s"]/.test(value)) return value
  let quoted = '"'
  let backslashes = 0
  for (const char of value) {
    if (char === '\\') {
      backslashes += 1
      continue
    }
    quoted += char === '"' ? `${'\\'.repeat(backslashes * 2 + 1)}"` : `${'\\'.repeat(backslashes)}${char}`
    backslashes = 0
  }
  return `${quoted}${'\\'.repeat(backslashes * 2)}"`
}

/** The arguments CommandLineToArgvW gives for a command line that follows the program name. */
export function splitWindowsArgs(text: string): string[] {
  const args: string[] = []
  let current = ''
  let inArg = false
  let inQuotes = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? ''
    if (!inQuotes && /\s/.test(char)) {
      if (inArg) args.push(current)
      current = ''
      inArg = false
      continue
    }
    inArg = true
    if (char === '\\') {
      let count = 0
      while (text[index + count] === '\\') count += 1
      index += count - 1
      if (text[index + 1] === '"') {
        current += '\\'.repeat(Math.floor(count / 2))
        if (count % 2 === 1) {
          current += '"'
          index += 1
        }
      } else {
        current += '\\'.repeat(count)
      }
    } else if (char === '"') {
      // Inside quotes, "" is a literal quote and the quoted part goes on.
      if (inQuotes && text[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
    } else {
      current += char
    }
  }
  if (inArg) args.push(current)
  return args
}

const XML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' }

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char] ?? char)
}

/** One pass, so `&amp;lt;` reads back as `&lt;` and not as `<`. */
function unescapeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (_, name: string) => XML_ENTITIES[name] ?? '')
}

function daemonArgs(input: TaskXmlInput): string[] {
  const script = input.script !== undefined ? [input.script] : []
  const port = input.port === DEFAULT_PORT ? [] : ['--port', String(input.port)]
  return [input.program, ...script, '--data-dir', input.dataDir, 'daemon', '--log-file', input.logFile, ...port]
}

export function taskXml(input: TaskXmlInput): string {
  const user = escapeXml(input.user)
  const args = escapeXml(['--headless', ...daemonArgs(input).map(windowsArg)].join(' '))
  return [
    '\uFEFF<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Kinfold memory daemon for this user</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    `      <UserId>${user}</UserId>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${user}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>3</Count>',
    '    </RestartOnFailure>',
    '    <Hidden>true</Hidden>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    // conhost --headless gives the daemon a console that is never shown, so nothing flashes up at logon.
    '      <Command>%SystemRoot%\\System32\\conhost.exe</Command>',
    `      <Arguments>${args}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n')
}

/** The Exec arguments taskXml wrote, split as Windows splits them; null when there are none. */
function taskArgs(xml: string): string[] | null {
  const match = /<Arguments>([^<]*)<\/Arguments>/.exec(xml)
  return match === null ? null : splitWindowsArgs(unescapeXml(match[1] ?? ''))
}

function flagValue(xml: string, flag: string): string | null {
  const args = taskArgs(xml)
  if (args === null) return null
  const index = args.indexOf(flag)
  return index < 0 ? null : args[index + 1] ?? null
}

export function taskDataDir(xml: string): string | null {
  const value = flagValue(xml, '--data-dir')
  return value === null || value === '' ? null : value
}

export function taskPort(xml: string): number | null {
  const value = flagValue(xml, '--port')
  if (value === null || !/^\d+$/.test(value)) return null
  const port = Number(value)
  return port >= 1 && port <= MAX_PORT ? port : null
}

export class ScheduledTaskService implements ServiceControl {
  readonly label = 'scheduled task'
  /** schtasks /Create /XML rejects a UTF-8 file as malformed; it reads UTF-16LE with a BOM. */
  readonly configEncoding = 'utf16le' as const

  constructor(
    private readonly env: InstallEnv,
    private readonly deps: TaskProcessDeps = processDeps,
  ) {}

  private get path(): string {
    return taskConfigPath(this.env)
  }

  private schtasks(...args: string[]): Promise<{ exitCode: number }> {
    return this.env.run({ argv: [schtasksPath(this.env), ...args], timeoutMs: SCHTASKS_TIMEOUT_MS })
  }

  private async schtasksOrThrow(verb: string, ...args: string[]): Promise<void> {
    const { exitCode } = await this.schtasks(`/${verb}`, ...args)
    if (exitCode !== 0) throw new Error(`${this.label}: schtasks /${verb} failed (exit ${exitCode})`)
  }

  private async isRegistered(): Promise<boolean> {
    return (await this.schtasks('/Query', '/TN', TASK_NAME)).exitCode === 0
  }

  /**
   * daemon.json's pid, only while that process is our daemon: alive, and the
   * /health on daemon.json's port names the same pid. A Windows stop
   * terminates the daemon, so it never removes daemon.json, and Windows soon
   * hands its pid to some other process.
   */
  private async daemonPid(): Promise<number | null> {
    const { pid, port } = readDaemonInfo(this.configuredDataDir() ?? this.env.dataDir)
    if (pid === null || !this.deps.pidAlive(pid)) return null
    const health = await checkHealth(this.env, port)
    return health.up && health.pid === pid ? pid : null
  }

  private readConfig(): string | null {
    try {
      // UTF-16LE since schtasks refused the UTF-8 file; an older UTF-8 one still reads.
      return decodeText(readFileSync(this.path))
    } catch {
      return null
    }
  }

  isConfigured(): boolean {
    return existsSync(this.path)
  }

  async isRunning(): Promise<boolean> {
    return (await this.isRegistered()) && (await this.daemonPid()) !== null
  }

  async start(): Promise<void> {
    await this.schtasksOrThrow('Create', '/TN', TASK_NAME, '/XML', this.path, '/F')
    await this.schtasksOrThrow('Run', '/TN', TASK_NAME)
  }

  async stop(): Promise<void> {
    if (!(await this.isRegistered())) return
    // /End fails when the task is not running, which is fine: the wait below decides.
    await this.schtasks('/End', '/TN', TASK_NAME)
    let pid = await this.daemonPid()
    for (let waited = 0; pid !== null && waited < HEALTH_WAIT_MS; waited += STOP_POLL_MS) {
      await this.env.sleep(STOP_POLL_MS)
      pid = await this.daemonPid()
    }
    // Only a pid that still answers as our daemon is killed; anything else has exited or is not ours.
    if (pid !== null) this.deps.kill(pid)
    await this.schtasksOrThrow('Delete', '/TN', TASK_NAME, '/F')
  }

  configuredDataDir(): string | null {
    const xml = this.readConfig()
    return xml === null ? null : taskDataDir(xml)
  }

  configuredPort(): number | null {
    const xml = this.readConfig()
    return xml === null ? null : taskPort(xml)
  }

  async fileHolders(_path: string): Promise<string> {
    return ''
  }

  configPath(): string {
    return this.path
  }

  configContent(port: number): string | null {
    const vars = this.env.envVars ?? {}
    const name = vars.USERNAME
    if (name === undefined || name === '') return null
    const domain = vars.USERDOMAIN
    const user = domain !== undefined && domain !== '' ? `${domain}\\${name}` : name
    const mode = this.env.mode
    const entry = mode.kind === 'program' ? { program: mode.binPath } : { program: mode.bunPath, script: join(mode.projectRoot, CHECKOUT_CLI) }
    const logFile = windowsJoin(this.env.dataDir, 'logs', 'daemon.log')
    return taskXml({ user, ...entry, dataDir: this.env.dataDir, port, logFile })
  }

  describe(step: ServiceStep): string {
    return step === 'start'
      ? `schtasks /Create /TN ${TASK_NAME} /XML ${this.path} /F, then schtasks /Run /TN ${TASK_NAME}`
      : `schtasks /End /TN ${TASK_NAME}, wait for the daemon to exit, then schtasks /Delete /TN ${TASK_NAME} /F`
  }

  unavailableReason(): string | null {
    const name = this.env.envVars?.USERNAME
    return name === undefined || name === '' ? NO_USERNAME : null
  }
}
