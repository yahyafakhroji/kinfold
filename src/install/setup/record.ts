// The saved setup: <dataDir>/install.json. It holds only what no live source
// knows: how this copy was installed, whether it may check for updates, and
// when it was first installed. Hosts, observers, encryption and the port are
// read back from the machine each time, so nothing is stored twice.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readEnv } from '../../env-names'
import { DATA_FILE_MODE } from '../../store/data-dir'
import type { InstallEnv } from '../env'
import type { Action } from '../plan'

export const INSTALL_RECORD_FILE = 'install.json'

const CHANNELS = ['npx', 'bunx', 'curl', 'powershell', 'checkout'] as const
export type InstallChannel = (typeof CHANNELS)[number]
/** What a launcher or install script can say; `checkout` is decided by the run mode alone. */
const LAUNCHER_CHANNELS: readonly InstallChannel[] = ['npx', 'bunx', 'curl', 'powershell']
const DEFAULT_CHANNEL: InstallChannel = 'curl'

export interface InstallRecord {
  channel: InstallChannel
  updateCheck: boolean
  firstInstalledAt: number
}

function isChannel(value: unknown): value is InstallChannel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value)
}

/** The saved record; null when the file is missing, unreadable or does not have the three fields. */
export function readInstallRecord(dataDir: string): InstallRecord | null {
  const path = join(dataDir, INSTALL_RECORD_FILE)
  if (!existsSync(path)) return null
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const { channel, updateCheck, firstInstalledAt } = value as Record<string, unknown>
    if (!isChannel(channel) || typeof updateCheck !== 'boolean') return null
    if (typeof firstInstalledAt !== 'number' || !Number.isFinite(firstInstalledAt)) return null
    return { channel, updateCheck, firstInstalledAt }
  } catch {
    return null
  }
}

/** A write at 0600 with exactly the three keys, in a fixed order. */
export function installRecordAction(dataDir: string, record: InstallRecord): Action {
  const content = `${JSON.stringify({ channel: record.channel, updateCheck: record.updateCheck, firstInstalledAt: record.firstInstalledAt }, null, 2)}\n`
  return { kind: 'write', path: join(dataDir, INSTALL_RECORD_FILE), content, mode: DATA_FILE_MODE, summary: `record the install channel (${record.channel}) and the update check (${record.updateCheck ? 'on' : 'off'})` }
}

/** A checkout is always `checkout`; else the launcher's word, else the saved one, else a curl install. */
export function currentChannel(env: InstallEnv, saved: InstallRecord | null): InstallChannel {
  if (env.mode.kind === 'checkout') return 'checkout'
  const named = readEnv(env.envVars ?? {}, 'INSTALL_CHANNEL')
  const launcher = LAUNCHER_CHANNELS.find((channel) => channel === named)
  return launcher ?? saved?.channel ?? DEFAULT_CHANNEL
}
