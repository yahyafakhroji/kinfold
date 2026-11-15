// The update notice: which release is newer than the one running, the words
// that announce it, and who has been told. The daemon's daily check writes
// the newest version; this module only reads it, and marks a host as told
// through the shared merge in state.ts. The user sees "is available" with the
// command to run; an agent, which has no user channel, is told it may pass
// the news on.

import type { UpdateNotice } from '../context/types'
import { type InstallChannel, type InstallRecord, readInstallRecord } from '../install/setup/record'
import { type AutoUpdateState, STALE_ATTEMPT_MS, lostAttempt, readAutoState } from './auto-state'
import { autoUpdateSetting, updatesEnabled } from './enabled'
import { type UpdateState, markNotified, readUpdateState } from './state'
import { compareVersions, isPatchUpdate, parseVersion } from './version-order'

export type { UpdateNotice } from '../context/types'
export { STALE_ATTEMPT_MS }
export { agentLine, availableMessage, installCommand, updateCommand, userMessage } from './notice-text'

type Env = Readonly<Record<string, string | undefined>>

function noticeChannel(record: InstallRecord | null): UpdateNotice['channel'] {
  const channel = record?.channel ?? 'curl'
  return channel === 'checkout' ? 'curl' : channel
}

/** Given only where a patch release will install itself: the saved attempts and the time, to tell a held-back notice from a lost one. */
export interface AutoHold {
  auto: AutoUpdateState
  now: number
}

/**
 * The newer release to install by hand, or null: nothing newer known, or
 * updates are off here (see updatesEnabled). With `hold`, a patch that
 * auto-update will install is held back, so the user is not told to do what
 * is about to be done. The notice comes back once that update has failed, or
 * once its attempt has gone an hour without a result.
 */
export function pendingNotice(state: UpdateState, record: InstallRecord | null, running: string, env: Env, hold?: AutoHold): UpdateNotice | null {
  if (!updatesEnabled(running, record, env)) return null
  const latest = state.latestVersion
  if (latest === null || parseVersion(latest) === null) return null
  if (compareVersions(latest, running) <= 0) return null
  if (hold !== undefined && isPatchUpdate(running, latest) && autoUpdateSetting(running, record, env).on) {
    // A blocker stops every patch, not only the one it was recorded for.
    const gaveUp = hold.auto.failure?.version === latest || hold.auto.failure?.blocked === true || lostAttempt(hold.auto, hold.now)?.version === latest
    if (!gaveUp) return null
  }
  return { version: latest, channel: noticeChannel(record) }
}

/** Whether this daemon applies patch releases itself, and the time: what decides if a patch notice is held back. */
export interface NoticeContext {
  capable: boolean
  now: number
}

const holdOf = (auto: AutoUpdateState, context: NoticeContext | undefined): AutoHold | undefined => (context?.capable === true ? { auto, now: context.now } : undefined)

/** A notice and where its "told" mark goes in update-check.json's `notified`. */
interface Owed {
  notice: UpdateNotice
  key: string
  mark: string
}

/** The update Kinfold installed itself, while that version is still the one running. */
function updatedNotice(auto: AutoUpdateState, record: InstallRecord | null, running: string, env: Env): UpdateNotice | null {
  if (!updatesEnabled(running, record, env) || auto.updated === null || auto.updated.version !== running) return null
  return { kind: 'updated', version: running, previous: auto.updated.previous, channel: noticeChannel(record) }
}

/**
 * What `host` is owed, first to last: for an install that predates
 * auto-update, that it is now on; the update that happened; then the release
 * to install by hand. One is shown per session start; the next waits for the
 * next session.
 */
function owedNotice(dataDir: string, host: string, running: string, env: Env, context?: NoticeContext): Owed | null {
  const state = readUpdateState(dataDir)
  const record = readInstallRecord(dataDir)
  const auto = readAutoState(dataDir)
  const introOwed = record?.autoUpdateIntro === true && autoUpdateSetting(running, record, env).on
  if (introOwed && state.notified[`auto-on:${host}`] === undefined) return { notice: { kind: 'auto-on', version: running, channel: noticeChannel(record) }, key: `auto-on:${host}`, mark: '1' }
  const updated = updatedNotice(auto, record, running, env)
  if (updated !== null && state.notified[`updated:${host}`] !== running) return { notice: updated, key: `updated:${host}`, mark: running }
  const available = pendingNotice(state, record, running, env, holdOf(auto, context))
  if (available !== null && state.notified[host] !== available.version) return { notice: available, key: host, mark: available.version }
  return null
}

/** The notice `host` has not seen yet, without marking it. */
export function peekNotice(dataDir: string, host: string, running: string, env: Env, context?: NoticeContext): UpdateNotice | null {
  return owedNotice(dataDir, host, running, env, context)?.notice ?? null
}

/** The notice for `host` if it has not seen it, marking it seen. Each host sees each notice once. */
export function takeNotice(dataDir: string, host: string, running: string, env: Env, context?: NoticeContext): UpdateNotice | null {
  const owed = owedNotice(dataDir, host, running, env, context)
  if (owed !== null) markNotified(dataDir, owed.key, owed.mark)
  return owed?.notice ?? null
}

const DASHBOARD = 'dashboard'

/**
 * The dashboard's banner: once, that Kinfold updated itself; otherwise the
 * release to install by hand, for as long as there is one. The auto-update
 * switch is on the page itself, so the banner never carries that notice.
 */
export function bannerNotice(dataDir: string, running: string, env: Env, context?: NoticeContext, markShown: boolean = true): UpdateNotice | null {
  const state = readUpdateState(dataDir)
  const record = readInstallRecord(dataDir)
  const auto = readAutoState(dataDir)
  const updated = updatedNotice(auto, record, running, env)
  if (updated !== null && state.notified[`updated:${DASHBOARD}`] !== running) {
    if (markShown) markNotified(dataDir, `updated:${DASHBOARD}`, running)
    return updated
  }
  return pendingNotice(state, record, running, env, holdOf(auto, context))
}
