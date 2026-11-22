// <dataDir>/updates/run.json: how the dashboard's Install button is going.
// The daemon writes "running" when it starts the detached updater, and the
// updater writes the result. The daemon restarts in between, so this file is
// what lets the new daemon tell the page how it ended.

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '../../system/fs/atomic'
import { DATA_FILE_MODE } from '../../resources/store/data-dir'
import { STAGE_DIR } from './stage'

export const INSTALL_RUN_FILE = 'run.json'
const STATES = ['running', 'updated', 'failed'] as const

export interface InstallRun {
  version: string
  /** The version that was running when the install started. */
  previous: string
  state: (typeof STATES)[number]
  /** The updater's last line on failure; null otherwise. */
  message: string | null
  at: number
}

export function readInstallRun(dataDir: string): InstallRun | null {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, STAGE_DIR, INSTALL_RUN_FILE), 'utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    const { version, previous, state, message, at } = value as Record<string, unknown>
    if (typeof version !== 'string' || typeof previous !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null
    if (!(STATES as readonly unknown[]).includes(state)) return null
    return { version, previous, state: state as InstallRun['state'], message: typeof message === 'string' ? message : null, at }
  } catch {
    return null
  }
}

export function writeInstallRun(dataDir: string, run: InstallRun): void {
  mkdirSync(join(dataDir, STAGE_DIR), { recursive: true, mode: 0o700 })
  writeFileAtomic(join(dataDir, STAGE_DIR, INSTALL_RUN_FILE), `${JSON.stringify(run, null, 2)}\n`, DATA_FILE_MODE)
}
