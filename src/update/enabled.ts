// The one answer to "may Kinfold check for, and announce, updates here":
// the daily check, the notices, the dashboard banner and `kinfold status` all ask it.

import { envName, readEnv } from '../env-names'
import type { InstallRecord } from '../install/setup/record'
import { parseVersion } from './version-order'

const DEV_VERSION = '0.0.0-dev'

export function updatesEnabled(running: string, record: InstallRecord | null, env: Readonly<Record<string, string | undefined>>): boolean {
  if (running === DEV_VERSION || parseVersion(running) === null) return false
  if (readEnv(env, 'NO_UPDATE_CHECK') === '1') return false
  return record === null || (record.updateCheck && record.channel !== 'checkout')
}

export type AutoUpdateSetting = { on: true } | { on: false; reason: string }

/**
 * Whether this install applies patch releases on its own. It needs the update
 * check, which finds the release, and an install record, since only an
 * installed copy has a program `kinfold update` can replace.
 */
export function autoUpdateSetting(running: string, record: InstallRecord | null, env: Readonly<Record<string, string | undefined>>): AutoUpdateSetting {
  if (record === null) return { on: false, reason: 'no install record' }
  if (!updatesEnabled(running, record, env)) return { on: false, reason: 'the update check is off' }
  if (readEnv(env, 'NO_AUTO_UPDATE') === '1') return { on: false, reason: `${envName('NO_AUTO_UPDATE')} is set` }
  return record.autoUpdate ? { on: true } : { on: false, reason: 'turned off' }
}
