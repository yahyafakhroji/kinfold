// The update notice: which release is newer than the one running, the words
// that announce it, and who has been told. The daemon's daily check writes
// the newest version; this module only reads it, and marks a host as told
// through the shared merge in state.ts. The user sees "is available" with the
// command to run; an agent, which has no user channel, is told it may pass
// the news on.

import type { UpdateNotice } from '../context/types'
import { type InstallChannel, type InstallRecord, readInstallRecord } from '../install/setup/record'
import { type UpdateState, markNotified, readUpdateState } from './state'
import { compareVersions, parseVersion } from './version-order'

export type { UpdateNotice } from '../context/types'
export { agentLine, availableMessage, updateCommand } from './notice-text'

const DEV_VERSION = '0.0.0-dev'

/** The newer release, or null: nothing newer known, a dev build, a checkout, or the check turned off in the install record. */
export function pendingNotice(state: UpdateState, record: InstallRecord | null, running: string): UpdateNotice | null {
  if (record !== null && (!record.updateCheck || record.channel === 'checkout')) return null
  const latest = state.latestVersion
  if (latest === null || running === DEV_VERSION) return null
  if (parseVersion(latest) === null || parseVersion(running) === null) return null
  if (compareVersions(latest, running) <= 0) return null
  const channel = record?.channel ?? 'curl'
  return { version: latest, channel: channel === 'checkout' ? 'curl' : channel }
}

/** The notice `host` has not seen yet, without marking it. */
export function peekNotice(dataDir: string, host: string, running: string): UpdateNotice | null {
  const notice = pendingNotice(readUpdateState(dataDir), readInstallRecord(dataDir), running)
  return notice === null || readUpdateState(dataDir).notified[host] === notice.version ? null : notice
}

/** The notice for `host` if it has not seen this version, marking it seen. Each host sees a version once. */
export function takeNotice(dataDir: string, host: string, running: string): UpdateNotice | null {
  const notice = peekNotice(dataDir, host, running)
  if (notice !== null) markNotified(dataDir, host, notice.version)
  return notice
}
