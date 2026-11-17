// The update notice: which release is newer than the one running, the words
// that announce it, and who has been told. The daemon's daily check writes
// the newest version; this module only reads it, and marks a host as told
// through the shared merge in state.ts. The user sees "is available" with the
// command to run, or "is ready" for a staged release; no notice ever goes
// into a model's context.

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { UpdateNotice } from '../context/types'
import { DATA_DIR_NAME } from '../names'
import { currentPlatform, osOf } from '../platform/platform'
import { type InstallChannel, type InstallRecord, readInstallRecord } from '../install/setup/record'
import { type AutoUpdateState, STALE_ATTEMPT_MS, lostAttempt, readAutoState } from './auto-state'
import { autoUpdateSetting, betaChannelOn, updatesEnabled } from './enabled'
import { releaseAssetName } from '../install/self-install'
import { releaseKind } from './release'
import { readStageRecord, stagedProgram } from './stage'
import { type UpdateState, knownRelease, markNotified, readUpdateState } from './state'
import { compareVersions, isPatchUpdate } from './version-order'

export type { UpdateNotice } from '../context/types'
export { STALE_ATTEMPT_MS }
export { availableMessage, installCommand, updateCommand, userMessage } from './notice-text'

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

/** Where a release that waits for a yes is staged: the data folder, this platform, and whether a daemon here stages at all. */
export interface StageContext {
  dataDir: string
  platform: NodeJS.Platform
  arch: string
  capable: boolean
  /** Now; past STAGE_WAIT_MS after the check that found the release, staging that never reported back is given up on. Absent: never. */
  now?: number
}

/** Long enough for a release download on a slow line; past it the release is told rather than held for an offer that may never come. */
export const STAGE_WAIT_MS = 3_600_000

/**
 * Whether a release bigger than a patch is still being staged at the patch
 * level, so its notice waits for the offer. It stops waiting once staging
 * failed for it or cannot happen here, and the release is told instead.
 */
function stillStaging(stage: StageContext, version: string, checkedAt: number | null): boolean {
  if (!stage.capable || releaseAssetName(stage.platform, stage.arch) === null) return false
  if (stage.now !== undefined && checkedAt !== null && stage.now - checkedAt > STAGE_WAIT_MS) return false
  return readStageRecord(stage.dataDir).failure?.version !== version
}

/**
 * The newer release to tell about, or null: nothing newer known, or
 * updates are off here (see updatesEnabled). With `hold`, a patch that
 * auto-update will install is held back, so the user is not told to do what
 * is about to be done. The notice comes back once that update has failed, or
 * once its attempt has gone an hour without a result. With `stage`, at the
 * patch level, a bigger release is offered once its program is staged and
 * held while it is being staged.
 */
export function pendingNotice(state: UpdateState, record: InstallRecord | null, running: string, env: Env, hold?: AutoHold, stage?: StageContext): UpdateNotice | null {
  if (!updatesEnabled(running, record, env)) return null
  const release = knownRelease(state, betaChannelOn(record, running))
  if (release === null || compareVersions(release.version, running) <= 0) return null
  const latest = release.version
  const patchLevel = autoUpdateSetting(running, record, env).on
  if (hold !== undefined && isPatchUpdate(running, latest) && patchLevel) {
    // A blocker stops every patch, not only the one it was recorded for.
    const gaveUp = hold.auto.failure?.version === latest || hold.auto.failure?.blocked === true || lostAttempt(hold.auto, hold.now)?.version === latest
    if (!gaveUp) return null
  }
  // Counts only from lines the check saw for this release: a state from before them knows the version alone.
  const counts = state.release?.version === latest ? { changes: release.changes.length, breaking: release.breaking.length } : {}
  const base = { version: latest, channel: noticeChannel(record), ...counts, ...(release.prerelease ? { prerelease: true as const } : {}) }
  if (stage !== undefined && patchLevel && releaseKind(running, latest) !== 'patch') {
    if (stagedProgram(stage.dataDir, stage.platform)?.version === latest) return { kind: 'offer', ...base }
    if (stillStaging(stage, latest, state.checkedAt)) return null
  }
  return base
}

const stageHere = (dataDir: string, context: NoticeContext | undefined, platform: NodeJS.Platform = context?.platform ?? currentPlatform().node): StageContext => ({ dataDir, platform, arch: context?.arch ?? process.arch, capable: context?.capable === true, now: context?.now ?? Date.now() })

/** Whether this daemon applies patch releases itself, and the time: what decides if a patch notice is held back. */
export interface NoticeContext {
  capable: boolean
  now: number
  /** Where this daemon stages releases; absent: this process's own platform. */
  platform?: NodeJS.Platform
  arch?: string
}

const holdOf = (auto: AutoUpdateState, context: NoticeContext | undefined): AutoHold | undefined => (context?.capable === true ? { auto, now: context.now } : undefined)

/** A notice and where its "told" mark goes in update-check.json's `notified`. */
interface Owed {
  notice: UpdateNotice
  key: string
  mark: string
}

/**
 * The installed program to run with `install`, for an install that was never
 * asked about the `kinfold` command: its record has no pathSetup. An automatic
 * update leaves PATH and the shell files alone for such an install, so this
 * line is how its user learns the command can be added. Only where install
 * would offer it: a program, in the default folder.
 */
function addCommandFor(dataDir: string, record: InstallRecord | null, env: Env, platform: NodeJS.Platform): string | undefined {
  if (record === null || record.pathSetup !== undefined || record.channel === 'checkout') return undefined
  const windows = osOf(platform) === 'windows'
  const home = (windows ? env.USERPROFILE : env.HOME) ?? homedir()
  if (resolve(dataDir) !== resolve(join(home, DATA_DIR_NAME))) return undefined
  // By the variable, as POSIX goes by ~: the line then reads the same for a home with any name in it, and crosses the wire as a plain path.
  return windows ? `%USERPROFILE%\\${DATA_DIR_NAME}\\bin\\kinfold.exe` : `~/${DATA_DIR_NAME}/bin/kinfold`
}

/** The update Kinfold installed itself, while that version is still the one running. */
function updatedNotice(dataDir: string, auto: AutoUpdateState, record: InstallRecord | null, running: string, env: Env, platform: NodeJS.Platform = currentPlatform().node): UpdateNotice | null {
  if (!updatesEnabled(running, record, env) || auto.updated === null || auto.updated.version !== running) return null
  const addCommand = addCommandFor(dataDir, record, env, platform)
  return { kind: 'updated', version: running, previous: auto.updated.previous, channel: noticeChannel(record), ...(addCommand !== undefined ? { addCommand } : {}) }
}

/**
 * What `host` is owed, first to last: for an install that predates
 * auto-update, that it is now on; the update that happened; then the release
 * to install by hand. One is shown per session start; the next waits for the
 * next session.
 */
function owedNotice(dataDir: string, host: string, running: string, env: Env, context?: NoticeContext, platform?: NodeJS.Platform): Owed | null {
  const state = readUpdateState(dataDir)
  const record = readInstallRecord(dataDir)
  const auto = readAutoState(dataDir)
  const introOwed = record?.autoUpdateIntro === true && autoUpdateSetting(running, record, env).on
  if (introOwed && state.notified[`auto-on:${host}`] === undefined) return { notice: { kind: 'auto-on', version: running, channel: noticeChannel(record) }, key: `auto-on:${host}`, mark: '1' }
  const updated = updatedNotice(dataDir, auto, record, running, env, platform)
  if (updated !== null && state.notified[`updated:${host}`] !== running) return { notice: updated, key: `updated:${host}`, mark: running }
  const available = pendingNotice(state, record, running, env, holdOf(auto, context), stageHere(dataDir, context, platform))
  if (available !== null && state.notified[host] !== available.version) return { notice: available, key: host, mark: available.version }
  return null
}

/** The notice `host` has not seen yet, without marking it. */
export function peekNotice(dataDir: string, host: string, running: string, env: Env, context?: NoticeContext, platform?: NodeJS.Platform): UpdateNotice | null {
  return owedNotice(dataDir, host, running, env, context, platform)?.notice ?? null
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
  const updated = updatedNotice(dataDir, auto, record, running, env)
  if (updated !== null && state.notified[`updated:${DASHBOARD}`] !== running) {
    if (markShown) markNotified(dataDir, `updated:${DASHBOARD}`, running)
    return updated
  }
  return pendingNotice(state, record, running, env, holdOf(auto, context), stageHere(dataDir, context))
}
