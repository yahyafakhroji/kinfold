// The one answer to "may Kinfold check for, and announce, updates here":
// the daily check, the notices, the dashboard banner and `kinfold status` all ask it.

import { readEnv } from '../env-names'
import type { InstallRecord } from '../install/setup/record'
import { parseVersion } from './version-order'

const DEV_VERSION = '0.0.0-dev'

export function updatesEnabled(running: string, record: InstallRecord | null, env: Readonly<Record<string, string | undefined>>): boolean {
  if (running === DEV_VERSION || parseVersion(running) === null) return false
  if (readEnv(env, 'NO_UPDATE_CHECK') === '1') return false
  return record === null || (record.updateCheck && record.channel !== 'checkout')
}
