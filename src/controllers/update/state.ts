// <dataDir>/update-check.json: when the daily check last ran, the newest
// release it saw, and which notices were already shown. Missing or malformed
// reads as empty, so a damaged file only costs one extra check.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fs/atomic'
import { DATA_FILE_MODE } from '../store/data-dir'
import { MAX_CHANGE_CHARS, MAX_CHANGE_LINES, type ReleaseInfo } from './release'
import { parseVersion } from './version-order'

export const UPDATE_STATE_FILE = 'update-check.json'

export interface UpdateState {
  lastAttemptAt: number | null
  latestVersion: string | null
  checkedAt: number | null
  notified: Readonly<Record<string, string>>
  /** Whether the check that found latestVersion read the beta channel; null for a state from before it. */
  beta?: boolean | null
  /** latestVersion's change lines; null for a state from before them. */
  release?: ReleaseInfo | null
  /**
   * The newest final patch of the running major.minor the check saw, which
   * applies itself under `patch` even while latestVersion (a beta, say) waits
   * for a yes. Null when there is none, or for a state from before it.
   */
  patchVersion?: string | null
}

const EMPTY: UpdateState = { lastAttemptAt: null, latestVersion: null, checkedAt: null, notified: {}, beta: null, release: null, patchVersion: null }

function linesOf(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  return value.filter((line): line is string => typeof line === 'string').map((line) => line.slice(0, MAX_CHANGE_CHARS)).slice(0, MAX_CHANGE_LINES)
}

function releaseOf(value: unknown): ReleaseInfo | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { version, prerelease, changes, breaking } = value as Record<string, unknown>
  if (typeof version !== 'string' || parseVersion(version) === null || typeof prerelease !== 'boolean') return null
  const lines = linesOf(changes)
  const broken = linesOf(breaking)
  return lines === null || broken === null ? null : { version, prerelease, changes: lines, breaking: broken }
}

/**
 * The release on offer as the check last saw it, or null: none known, or a
 * prerelease while the beta channel is off, so a choice to leave the channel
 * counts at once and never waits for the next check.
 */
export function knownRelease(state: UpdateState, beta: boolean): ReleaseInfo | null {
  const version = state.latestVersion
  const parsed = version === null ? null : parseVersion(version)
  if (version === null || parsed === null) return null
  const release = state.release?.version === version ? state.release : { version, prerelease: parsed.pre !== null, changes: [], breaking: [] }
  return release.prerelease && !beta ? null : release
}

function timeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readUpdateState(dataDir: string): UpdateState {
  const path = join(dataDir, UPDATE_STATE_FILE)
  if (!existsSync(path)) return EMPTY
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY
    const { lastAttemptAt, latestVersion, checkedAt, notified, beta, release, patchVersion } = value as Record<string, unknown>
    const notes: Record<string, string> = {}
    if (typeof notified === 'object' && notified !== null && !Array.isArray(notified)) {
      for (const [key, note] of Object.entries(notified)) if (typeof note === 'string') notes[key] = note
    }
    return {
      lastAttemptAt: timeOrNull(lastAttemptAt),
      latestVersion: typeof latestVersion === 'string' ? latestVersion : null,
      checkedAt: timeOrNull(checkedAt),
      notified: notes,
      beta: typeof beta === 'boolean' ? beta : null,
      release: releaseOf(release),
      patchVersion: typeof patchVersion === 'string' && parseVersion(patchVersion) !== null ? patchVersion : null,
    }
  } catch {
    return EMPTY
  }
}

export function writeUpdateState(dataDir: string, state: UpdateState): void {
  const content = `${JSON.stringify({ lastAttemptAt: state.lastAttemptAt, latestVersion: state.latestVersion, checkedAt: state.checkedAt, notified: state.notified, beta: state.beta ?? null, release: state.release ?? null, patchVersion: state.patchVersion ?? null }, null, 2)}\n`
  writeFileAtomic(join(dataDir, UPDATE_STATE_FILE), content, DATA_FILE_MODE)
}

/**
 * Every writer goes through here: the file is read again right before the
 * write and only the fields the caller owns are replaced, so a slow daily check
 * cannot undo a notice marked meanwhile, nor the reverse. The check owns
 * lastAttemptAt, checkedAt, latestVersion, beta, release and patchVersion; notices own `notified`.
 */
export function mergeUpdateState(dataDir: string, change: Partial<UpdateState> | ((current: UpdateState) => Partial<UpdateState>)): void {
  const current = readUpdateState(dataDir)
  writeUpdateState(dataDir, { ...current, ...(typeof change === 'function' ? change(current) : change) })
}

/** Records that `host` was shown the notice for `version`; the other fields are left as they are on disk now. */
export function markNotified(dataDir: string, host: string, version: string): void {
  mergeUpdateState(dataDir, (current) => ({ notified: { ...current.notified, [host]: version } }))
}
