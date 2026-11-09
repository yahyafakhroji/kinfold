// The data dir rules from the Security section: the dir and every directory in
// it 0700, every file 0600, except the installed program, which is 0755. The daemon's umask covers files it creates; this
// fixes what something else created looser (claude-mem's DB was 0644 inside a
// 0700 dir). Symlinks are reported and left alone, never followed.

import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'
import { PROGRAM_MODE } from './self-install'

export interface ModeChange {
  /** Relative to the data dir; "." is the dir itself. */
  path: string
  kind: 'dir' | 'file'
  from: number
  to: number
}

export interface ModeScan {
  changes: ModeChange[]
  checked: number
  symlinks: string[]
}

function walk(root: string, dir: string, scan: ModeScan): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      scan.symlinks.push(relative(root, path))
      continue
    }
    if (!stat.isDirectory() && !stat.isFile()) continue
    visit(root, path, stat.isDirectory() ? 'dir' : 'file', stat.mode & 0o777, scan)
    if (stat.isDirectory()) walk(root, path, scan)
  }
}

const PROGRAM_PATHS: ReadonlySet<string> = new Set(['bin/kinfold', 'bin/kinfold.exe'])
/** Temp copies of the program made while updating; the running install must not chmod its own. */
const UPDATE_TEMP_PREFIX = 'bin/.kinfold-update-'

/** The mode a path under the data dir must have. `relative` uses backslashes on Windows. */
export function expectedMode(relativePath: string, kind: 'dir' | 'file'): number {
  if (kind === 'dir') return DATA_DIR_MODE
  return PROGRAM_PATHS.has(relativePath.replaceAll('\\', '/')) ? PROGRAM_MODE : DATA_FILE_MODE
}

function isUpdateTemp(relativePath: string): boolean {
  return relativePath.replaceAll('\\', '/').startsWith(UPDATE_TEMP_PREFIX)
}

function visit(root: string, path: string, kind: 'dir' | 'file', mode: number, scan: ModeScan): void {
  const rel = relative(root, path) || '.'
  if (isUpdateTemp(rel)) return
  scan.checked += 1
  const to = expectedMode(rel, kind)
  if (mode !== to) scan.changes.push({ path: rel, kind, from: mode, to })
}

/** Read-only: what would change. A missing data dir has nothing to fix. */
export function scanDataDirModes(dataDir: string): ModeScan {
  const scan: ModeScan = { changes: [], checked: 0, symlinks: [] }
  if (!existsSync(dataDir)) return scan
  visit(dataDir, dataDir, 'dir', lstatSync(dataDir).mode & 0o777, scan)
  walk(dataDir, dataDir, scan)
  return scan
}

export function applyModeChange(dataDir: string, change: ModeChange): void {
  chmodSync(join(dataDir, change.path), change.to)
}

export function formatMode(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`
}

export function describeModeChange(change: ModeChange): string {
  return `${change.path} ${formatMode(change.from)} -> ${formatMode(change.to)}`
}
