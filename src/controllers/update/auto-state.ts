// <dataDir>/auto-update.json: what the automatic update last tried, how it
// last failed and what it last installed. It is kept apart from
// update-check.json because the detached updater writes here while the daemon
// may be writing a notice there. Missing or malformed reads as empty: the only
// cost is one more attempt, or one notice not shown.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../system/fs/atomic'
import { DATA_FILE_MODE } from '../../resources/store/data-dir'

export const AUTO_STATE_FILE = 'auto-update.json'

export interface AutoUpdateAttempt {
  version: string
  /** The daily check that found this release; a later check with another time allows one more attempt. */
  checkedAt: number | null
  startedAt: number
}

export interface AutoUpdateFailure {
  version: string
  at: number
  /** A line the updater printed, which names causes and never quotes a response. */
  reason: string
  /**
   * The cause will not pass by waiting a day: the daemon is not run by a
   * service, or it cannot start a detached updater here. It is not tried
   * again until the daemon restarts, install.json changes, or the version does.
   */
  blocked?: true
  /** The version that was running; kept with a blocker, so a new version tries again. */
  running?: string
}

export interface AutoUpdateDone {
  version: string
  previous: string
  at: number
}

export interface AutoUpdateState {
  attempt: AutoUpdateAttempt | null
  failure: AutoUpdateFailure | null
  updated: AutoUpdateDone | null
}

/** How long an attempt may go without a recorded result before it counts as lost: the updater was killed, or never started. */
export const STALE_ATTEMPT_MS = 3_600_000

/** The last attempt when it left no result and is too old to still be running; null otherwise. */
export function lostAttempt(auto: AutoUpdateState, now: number): AutoUpdateAttempt | null {
  const attempt = auto.attempt
  if (attempt === null || now - attempt.startedAt <= STALE_ATTEMPT_MS) return null
  const hasResult = auto.failure?.version === attempt.version || auto.updated?.version === attempt.version
  return hasResult ? null : attempt
}

const EMPTY: AutoUpdateState = { attempt: null, failure: null, updated: null }

function fieldsOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function attemptOf(value: unknown): AutoUpdateAttempt | null {
  const fields = fieldsOf(value)
  if (fields === null || typeof fields.version !== 'string' || !isTime(fields.startedAt)) return null
  return { version: fields.version, checkedAt: isTime(fields.checkedAt) ? fields.checkedAt : null, startedAt: fields.startedAt }
}

function failureOf(value: unknown): AutoUpdateFailure | null {
  const fields = fieldsOf(value)
  if (fields === null || typeof fields.version !== 'string' || !isTime(fields.at) || typeof fields.reason !== 'string') return null
  return {
    version: fields.version,
    at: fields.at,
    reason: fields.reason,
    ...(fields.blocked === true ? { blocked: true as const } : {}),
    ...(typeof fields.running === 'string' ? { running: fields.running } : {}),
  }
}

function doneOf(value: unknown): AutoUpdateDone | null {
  const fields = fieldsOf(value)
  if (fields === null || typeof fields.version !== 'string' || typeof fields.previous !== 'string' || !isTime(fields.at)) return null
  return { version: fields.version, previous: fields.previous, at: fields.at }
}

export function readAutoState(dataDir: string): AutoUpdateState {
  const path = join(dataDir, AUTO_STATE_FILE)
  if (!existsSync(path)) return EMPTY
  try {
    const fields = fieldsOf(JSON.parse(readFileSync(path, 'utf8')))
    if (fields === null) return EMPTY
    return { attempt: attemptOf(fields.attempt), failure: failureOf(fields.failure), updated: doneOf(fields.updated) }
  } catch {
    return EMPTY
  }
}

/** Read again right before the write, so the daemon's attempt and the updater's outcome never undo each other. */
export function mergeAutoState(dataDir: string, change: Partial<AutoUpdateState>): void {
  const next = { ...readAutoState(dataDir), ...change }
  writeFileAtomic(join(dataDir, AUTO_STATE_FILE), `${JSON.stringify({ attempt: next.attempt, failure: next.failure, updated: next.updated }, null, 2)}\n`, DATA_FILE_MODE)
}
