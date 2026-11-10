// The Windows service behind ServiceControl: a per-user scheduled task that
// starts the daemon at logon, registered and removed through schtasks.exe.
// schtasks prints localized text, so only exit codes are read. Whether the
// task runs comes from Task Scheduler's own state number, read through its COM
// object: a daemon that is still opening a large store answers nothing yet,
// and its task is running all the same. /health only decides which process a
// stop may kill.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PORT } from '../../daemon/daemon'
import { WINDOWS_QUERY_TIMEOUT_MS, powershellArgv, psLiteral } from '../access/windows-acl'
import { checkHealth, readDaemonInfo } from '../daemon-client'
import { decodeText } from '../files'
import type { CommandResult, InstallEnv } from '../env'
import { HEALTH_WAIT_MS } from '../plan'
import { windowsJoin, windowsSystemTool } from '../windows-system-path'
import type { ServiceControl, ServiceStep } from './control'

export const TASK_NAME = 'KinfoldDaemon'
/** In <LOCALAPPDATA>\Kinfold: outside the data folder, so WSL can find it without knowing that folder. */
export const TASK_CONFIG_FILE = 'kinfold-daemon.xml'
export const STOP_POLL_MS = 250
const SCHTASKS_TIMEOUT_MS = 15_000
const MAX_PORT = 65_535
/** Task Scheduler's TASK_STATE numbers for a task with an instance: queued, and running. */
const ACTIVE_TASK_STATES: readonly number[] = [2, 4]
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

/**
 * Prints `state<TAB><TASK_STATE number>`; fails when Task Scheduler has no
 * such task. Reads only. .NET calls throughout, no cmdlet: the CLI gives its
 * children only PATH and HOME, and without PSModulePath loading New-Object's
 * module outlasts the timeout.
 */
export function taskStateScript(): string {
  return [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference = 'Stop'",
    "$scheduler = [System.Activator]::CreateInstance([System.Type]::GetTypeFromProgID('Schedule.Service'))",
    '$scheduler.Connect()',
    `$task = $scheduler.GetFolder('\\').GetTask(${psLiteral(TASK_NAME)})`,
    '"state`t$([int]$task.State)"',
  ].join('\n')
}

/** The state number the query printed; null when it failed, timed out or printed anything else. */
export function taskStateOf(result: CommandResult): number | null {
  if (result.timedOut === true || result.exitCode !== 0) return null
  const match = /^state\t(\d+)$/.exec(result.stdout.replace(/^\uFEFF/, '').trim())
  return match === null ? null : Number(match[1])
}

type TaskActivity = 'active' | 'idle' | 'unknown'

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

  async isRegistered(): Promise<boolean> {
    return (await this.schtasks('/Query', '/TN', TASK_NAME)).exitCode === 0
  }

  private async activity(): Promise<TaskActivity> {
    const state = taskStateOf(await this.env.run({ argv: powershellArgv(this.env, taskStateScript()), timeoutMs: WINDOWS_QUERY_TIMEOUT_MS }))
    if (state === null) return 'unknown'
    return ACTIVE_TASK_STATES.includes(state) ? 'active' : 'idle'
  }

  /** daemon.json's pid, when it is alive and the /health on daemon.json's port names it; 'other' when a different daemon answers there. */
  private async answeringDaemon(dataDir: string): Promise<number | 'other' | null> {
    const { pid, port } = readDaemonInfo(dataDir)
    const health = await checkHealth(this.env, port)
    if (!health.up) return null
    return pid !== null && health.pid === pid && this.deps.pidAlive(pid) ? pid : 'other'
  }

  /**
   * Waits for our daemon to exit and returns its pid when it outlasts the
   * wait; null when there is nothing of ours to kill. A pid is ours once
   * /health names it, and stays ours while it lives, so a daemon that has
   * closed its server is still killed. A Windows stop terminates the daemon,
   * so daemon.json is never removed and Windows soon hands its pid to some
   * other process: a pid /health does not name is never killed. While the
   * task had an instance and no daemon has answered yet, the wait goes on,
   * since a daemon that is still opening its store answers late.
   */
  private async daemonLeftRunning(known: number | null, taskWasActive: boolean): Promise<number | null> {
    const dataDir = this.configuredDataDir() ?? this.env.dataDir
    let ours = known
    for (let waited = 0; ; waited += STOP_POLL_MS) {
      if (ours !== null) {
        if (!this.deps.pidAlive(ours)) return null
      } else {
        const answering = await this.answeringDaemon(dataDir)
        if (typeof answering === 'number') ours = answering
        else if (answering === 'other' || !taskWasActive) return null
      }
      if (waited >= HEALTH_WAIT_MS) return ours
      await this.env.sleep(STOP_POLL_MS)
    }
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

  /** A state that cannot be read counts as running: a wrong "stopped" would end a start wait early or skip a stop. */
  async isRunning(): Promise<boolean> {
    return (await this.isRegistered()) && (await this.activity()) !== 'idle'
  }

  async start(): Promise<void> {
    await this.schtasksOrThrow('Create', '/TN', TASK_NAME, '/XML', this.path, '/F')
    await this.schtasksOrThrow('Run', '/TN', TASK_NAME)
  }

  async stop(): Promise<void> {
    if (!(await this.isRegistered())) return
    // Read before /End: ending the task ends its console host and leaves the daemon running, with nothing but /health to tell it by.
    const answering = await this.answeringDaemon(this.configuredDataDir() ?? this.env.dataDir)
    const taskWasActive = answering === null && (await this.activity()) === 'active'
    // /End fails when the task is not running, which is fine: the wait below decides.
    await this.schtasks('/End', '/TN', TASK_NAME)
    const pid = answering === 'other' ? null : await this.daemonLeftRunning(answering, taskWasActive)
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
