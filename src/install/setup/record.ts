// The saved setup: <dataDir>/install.json. It holds only what no live source
// knows: how this copy was installed, whether it may check for updates, and
// when it was first installed. Hosts, observers, encryption and the port are
// read back from the machine each time, so nothing is stored twice.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnv } from '../../env-names'
import { writeFileAtomic } from '../../fs/atomic'
import { DATA_FILE_MODE } from '../../store/data-dir'
import type { InstallEnv } from '../env'
import type { Action } from '../plan'

export const INSTALL_RECORD_FILE = 'install.json'

const CHANNELS = ['npx', 'bunx', 'curl', 'powershell', 'checkout'] as const
export type InstallChannel = (typeof CHANNELS)[number]
/** What a launcher or install script can say; `checkout` is decided by the run mode alone. */
const LAUNCHER_CHANNELS: readonly InstallChannel[] = ['npx', 'bunx', 'curl', 'powershell']
const DEFAULT_CHANNEL: InstallChannel = 'curl'

/**
 * The environment variables that move an agent's config folder. An install
 * finds and wires agents through them, so an update the daemon starts, whose
 * environment is the service's and not the shell's, has to be given the same
 * ones or it would look in the default folders. Only these names are ever
 * saved, and each holds a path: nothing secret travels this way.
 */
export const AGENT_HOME_VARS = ['CODEX_HOME', 'COPILOT_HOME', 'JUNIE_HOME', 'GEMINI_CLI_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME', 'CLINE_MCP_SETTINGS_PATH'] as const
export type AgentHomeVar = (typeof AGENT_HOME_VARS)[number]
export type AgentHomes = Readonly<Partial<Record<AgentHomeVar, string>>>

const HOME_FIELDS: Readonly<Record<AgentHomeVar, keyof InstallEnv>> = {
  CODEX_HOME: 'codexHomeEnv',
  COPILOT_HOME: 'copilotHomeEnv',
  JUNIE_HOME: 'junieHomeEnv',
  GEMINI_CLI_HOME: 'geminiCliHomeEnv',
  KIMI_CODE_HOME: 'kimiCodeHomeEnv',
  XDG_CONFIG_HOME: 'xdgConfigHomeEnv',
  CLINE_MCP_SETTINGS_PATH: 'clineMcpSettingsPathEnv',
}
const MAX_HOME_CHARS = 4096
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/

function isHomeValue(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= MAX_HOME_CHARS && !CONTROL_CHARACTER.test(value)
}

/** The agent home variables this install runs with; one that is unset or empty is left out. */
export function agentHomesOf(env: InstallEnv): AgentHomes {
  const homes: Partial<Record<AgentHomeVar, string>> = {}
  for (const name of AGENT_HOME_VARS) {
    const value = env[HOME_FIELDS[name]]
    if (isHomeValue(value)) homes[name] = value
  }
  return homes
}

/** `vars` with the saved homes put in and every other home variable taken out: one unset at install stays unset. A new object. */
export function applyAgentHomes(vars: Readonly<Record<string, string>>, homes: AgentHomes): Record<string, string> {
  const next: Record<string, string> = { ...vars }
  for (const name of AGENT_HOME_VARS) {
    const saved = homes[name]
    if (saved === undefined) delete next[name]
    else next[name] = saved
  }
  return next
}

function savedHomes(value: unknown): AgentHomes {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const homes: Partial<Record<AgentHomeVar, string>> = {}
  for (const name of AGENT_HOME_VARS) {
    const saved = (value as Record<string, unknown>)[name]
    if (isHomeValue(saved)) homes[name] = saved
  }
  return homes
}

export interface InstallRecord {
  channel: InstallChannel
  updateCheck: boolean
  /** Patch releases are applied without asking. A record written before this field existed reads as on. */
  autoUpdate: boolean
  /** The install predates auto-update, so each host is owed one notice that it is now on. */
  autoUpdateIntro: boolean
  /** The agent home variables the last install ran with; an automatic update runs its install with the same ones. */
  agentHomes: AgentHomes
  /** When autoUpdate was last chosen, by the dashboard or by an install; the later choice wins a write. Absent: never chosen. */
  autoUpdateAt?: number
  firstInstalledAt: number
}

function isChannel(value: unknown): value is InstallChannel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
}

/** The saved record; null when the file is missing, unreadable or a field it must have is missing or of the wrong type. */
export function readInstallRecord(dataDir: string): InstallRecord | null {
  const path = join(dataDir, INSTALL_RECORD_FILE)
  if (!existsSync(path)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const { channel, updateCheck, autoUpdate, autoUpdateIntro, autoUpdateAt, agentHomes, firstInstalledAt } = value as Record<string, unknown>
    if (!isChannel(channel) || typeof updateCheck !== 'boolean') return null
    if (typeof firstInstalledAt !== 'number' || !Number.isFinite(firstInstalledAt)) return null
    const rest = { agentHomes: savedHomes(agentHomes), ...(typeof autoUpdateAt === 'number' && Number.isFinite(autoUpdateAt) ? { autoUpdateAt } : {}), firstInstalledAt }
    // No autoUpdate key: written before the field existed, so it is on and its user has not been told yet.
    if (autoUpdate === undefined) return { channel, updateCheck, autoUpdate: true, autoUpdateIntro: true, ...rest }
    if (typeof autoUpdate !== 'boolean') return null
    return { channel, updateCheck, autoUpdate, autoUpdateIntro: autoUpdateIntro === true, ...rest }
  } catch {
    return null
  }
}

/** The file's text: the four keys in a fixed order, then the optional ones only when they hold something. */
function recordContent(record: InstallRecord): string {
  const fields = {
    channel: record.channel,
    updateCheck: record.updateCheck,
    autoUpdate: record.autoUpdate,
    firstInstalledAt: record.firstInstalledAt,
    ...(Object.keys(record.agentHomes).length > 0 ? { agentHomes: record.agentHomes } : {}),
    ...(record.autoUpdateAt !== undefined ? { autoUpdateAt: record.autoUpdateAt } : {}),
    ...(record.autoUpdateIntro ? { autoUpdateIntro: true } : {}),
  }
  return `${JSON.stringify(fields, null, 2)}\n`
}

/**
 * Writes the record at 0600. The file is read again first: when its
 * auto-update choice is newer than the one being written (the dashboard's
 * switch, flipped while an install or an automatic update ran), that choice is
 * kept, so the longer-running writer never undoes it.
 */
export function writeInstallRecord(dataDir: string, record: InstallRecord): void {
  const current = readInstallRecord(dataDir)
  const newer = current !== null && current.autoUpdateAt !== undefined && current.autoUpdateAt > (record.autoUpdateAt ?? 0)
  const merged = newer ? { ...record, autoUpdate: current.autoUpdate, autoUpdateAt: current.autoUpdateAt } : record
  writeFileAtomic(join(dataDir, INSTALL_RECORD_FILE), recordContent(merged), DATA_FILE_MODE)
}

/** The plan step that writes the record (writeInstallRecord). */
export function installRecordAction(dataDir: string, record: InstallRecord): Action {
  const summary = `record the install channel (${record.channel}), the update check (${record.updateCheck ? 'on' : 'off'}) and auto-update (${record.autoUpdate ? 'on' : 'off'})`
  return { kind: 'install-record', path: join(dataDir, INSTALL_RECORD_FILE), dataDir, record, summary }
}

/** The dashboard's switch: only autoUpdate changes, stamped with when. False when there is no record to change. */
export function setAutoUpdate(dataDir: string, enabled: boolean, now: number = Date.now()): boolean {
  const record = readInstallRecord(dataDir)
  if (record === null) return false
  writeFileAtomic(join(dataDir, INSTALL_RECORD_FILE), recordContent({ ...record, autoUpdate: enabled, autoUpdateAt: now }), DATA_FILE_MODE)
  return true
}

/** A checkout is always `checkout`; else the launcher's word, else the saved one, else a curl install. */
export function currentChannel(env: InstallEnv, saved: InstallRecord | null): InstallChannel {
  if (env.mode.kind === 'checkout') return 'checkout'
  const named = readEnv(env.envVars ?? {}, 'INSTALL_CHANNEL')
  const launcher = LAUNCHER_CHANNELS.find((channel) => channel === named)
  // A saved `checkout` belongs to the checkout run that wrote it; a program is never that.
  const savedChannel = saved?.channel === 'checkout' ? null : saved?.channel
  return launcher ?? savedChannel ?? DEFAULT_CHANNEL
}
