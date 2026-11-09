// <dataDir>/update-check.json: when the daily check last ran, the newest
// release it saw, and which notices were already shown. Missing or malformed
// reads as empty, so a damaged file only costs one extra check.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../fs/atomic'
import { DATA_FILE_MODE } from '../store/data-dir'

export const UPDATE_STATE_FILE = 'update-check.json'

export interface UpdateState {
  lastAttemptAt: number | null
  latestVersion: string | null
  checkedAt: number | null
  notified: Readonly<Record<string, string>>
}

const EMPTY: UpdateState = { lastAttemptAt: null, latestVersion: null, checkedAt: null, notified: {} }

function timeOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function readUpdateState(dataDir: string): UpdateState {
  const path = join(dataDir, UPDATE_STATE_FILE)
  if (!existsSync(path)) return EMPTY
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return EMPTY
    const { lastAttemptAt, latestVersion, checkedAt, notified } = value as Record<string, unknown>
    const notes: Record<string, string> = {}
    if (typeof notified === 'object' && notified !== null && !Array.isArray(notified)) {
      for (const [key, note] of Object.entries(notified)) if (typeof note === 'string') notes[key] = note
    }
    return {
      lastAttemptAt: timeOrNull(lastAttemptAt),
      latestVersion: typeof latestVersion === 'string' ? latestVersion : null,
      checkedAt: timeOrNull(checkedAt),
      notified: notes,
    }
  } catch {
    return EMPTY
  }
}

export function writeUpdateState(dataDir: string, state: UpdateState): void {
  const content = `${JSON.stringify({ lastAttemptAt: state.lastAttemptAt, latestVersion: state.latestVersion, checkedAt: state.checkedAt, notified: state.notified }, null, 2)}\n`
  writeFileAtomic(join(dataDir, UPDATE_STATE_FILE), content, DATA_FILE_MODE)
}
