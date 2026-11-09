// The update notice: which release is newer than the one running, the words
// that announce it, and who has been told. The daemon's daily check writes
// the newest version; this module only reads it, and marks a host as told
// through the shared merge in state.ts. The user sees "is available" with the
// command to run; an agent, which has no user channel, is told it may pass
// the news on.

import type { UpdateNotice } from '../context/types'
import { type InstallChannel, type InstallRecord, readInstallRecord } from '../install/setup/record'
import { updatesEnabled } from './enabled'
import { type UpdateState, markNotified, readUpdateState } from './state'
import { compareVersions, parseVersion } from './version-order'

export type { UpdateNotice } from '../context/types'
export { agentLine, availableMessage, updateCommand } from './notice-text'

type Env = Readonly<Record<string, string | undefined>>

/** The newer release, or null: nothing newer known, or updates are off here (see updatesEnabled). */
export function pendingNotice(state: UpdateState, record: InstallRecord | null, running: string, env: Env): UpdateNotice | null {
  if (!updatesEnabled(running, record, env)) return null
  const latest = state.latestVersion
  if (latest === null || parseVersion(latest) === null) return null
  if (compareVersions(latest, running) <= 0) return null
  const channel = record?.channel ?? 'curl'
  return { version: latest, channel: channel === 'checkout' ? 'curl' : channel }
}

/** The notice `host` has not seen yet, without marking it. */
export function peekNotice(dataDir: string, host: string, running: string, env: Env): UpdateNotice | null {
  const state = readUpdateState(dataDir)
  const notice = pendingNotice(state, readInstallRecord(dataDir), running, env)
  return notice === null || state.notified[host] === notice.version ? null : notice
}

/** The notice for `host` if it has not seen this version, marking it seen. Each host sees a version once. */
export function takeNotice(dataDir: string, host: string, running: string, env: Env): UpdateNotice | null {
  const notice = peekNotice(dataDir, host, running, env)
  if (notice !== null) markNotified(dataDir, host, notice.version)
  return notice
}
