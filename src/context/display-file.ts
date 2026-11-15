// display.json in the data folder: whether agents show what Kinfold recalled,
// and whether the impact test is on.
// The setting lives in the store (data_settings), which a hook cannot open in
// a compiled program and must not wait on; the daemon writes this copy at
// start and whenever the setting changes, and the hook reads it with one file
// read. That also lets the hook say "daemon not running" only to a user who
// wants the line. A missing or unreadable file means the default, shown.
// Node builtins only, so the hook and the OpenCode plugin can both load it.

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DISPLAY_FILE = 'display.json'

export interface DisplayFile {
  showRecall: boolean
  /** The impact test is on. Only `kinfold status` reads it here, so it can say so with the daemon down; the daemon decides each prompt from the store. */
  holdout: boolean
}

export function readDisplayFile(dataDir: string): DisplayFile {
  try {
    const value: unknown = JSON.parse(readFileSync(join(dataDir, DISPLAY_FILE), 'utf8'))
    const fields = typeof value === 'object' && value !== null ? (value as { showRecall?: unknown; holdout?: unknown }) : {}
    return { showRecall: fields.showRecall !== false, holdout: fields.holdout === true }
  } catch {
    return { showRecall: true, holdout: false }
  }
}

/** Written whole and renamed into place, so a hook never reads half a file. Holds no secret, but keeps the folder's 0600 like its neighbours. */
export function writeDisplayFile(dataDir: string, settings: Pick<DisplayFile, 'showRecall'> & Partial<DisplayFile>): void {
  const path = join(dataDir, DISPLAY_FILE)
  const content = `${JSON.stringify({ showRecall: settings.showRecall, holdout: settings.holdout === true })}\n`
  // The daemon publishes at every start; a file that already says this is left as it is.
  try {
    if (readFileSync(path, 'utf8') === content) return
  } catch {
    // Missing or unreadable: write it.
  }
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, content, { mode: 0o600 })
  renameSync(temp, path)
}
