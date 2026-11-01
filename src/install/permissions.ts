// The data dir rules from the Security section: the dir and every directory in
// it 0700, every file 0600. The daemon's umask covers files it creates; this
// fixes what something else created looser (claude-mem's DB was 0644 inside a
// 0700 dir). Symlinks are reported and left alone, never followed.

import { chmodSync, existsSync, lstatSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DATA_DIR_MODE, DATA_FILE_MODE } from '../store/data-dir'

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

function visit(root: string, path: string, kind: 'dir' | 'file', mode: number, scan: ModeScan): void {
  scan.checked += 1
  const to = kind === 'dir' ? DATA_DIR_MODE : DATA_FILE_MODE
  if (mode !== to) scan.changes.push({ path: relative(root, path) || '.', kind, from: mode, to })
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
