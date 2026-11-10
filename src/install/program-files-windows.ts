// The Windows program files. Windows refuses to overwrite or delete an .exe a
// process is running, and `kinfold update` is itself such a process, as is
// every agent session's MCP server. It does let a running image be renamed, so
// the old program is moved aside under a .kinfold-old- name and the new one
// takes its place; the moved-aside files go once nothing runs them.

import * as fs from 'node:fs'
import { win32 } from 'node:path'
import type { ProgramFiles } from './program-files'

export const OLD_PROGRAM_PREFIX = '.kinfold-old-'

export interface ProgramFsDeps {
  renameSync: typeof import('node:fs').renameSync
  rmSync: typeof import('node:fs').rmSync
  readdirSync: (dir: string) => string[]
  existsSync: (path: string) => boolean
  pid: number
  now: () => number
}

const defaultDeps = (): ProgramFsDeps => ({
  renameSync: fs.renameSync,
  rmSync: fs.rmSync,
  readdirSync: (dir) => fs.readdirSync(dir),
  existsSync: fs.existsSync,
  pid: process.pid,
  now: Date.now,
})

// The codes Windows gives for a file some process still has mapped or open.
const LOCKED_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

function isLocked(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code !== undefined && LOCKED_CODES.has(code)
}

/** Joins with the separator the folder already uses, so a forward-slash path stays one. */
function childOf(dir: string, name: string): string {
  return `${dir}${dir.includes('\\') ? '\\' : '/'}${name}`
}

const isOldProgram = (name: string) => name.startsWith(OLD_PROGRAM_PREFIX) && name.toLowerCase().endsWith('.exe')

export function createWindowsProgramFiles(overrides: Partial<ProgramFsDeps> = {}): ProgramFiles {
  const deps: ProgramFsDeps = { ...defaultDeps(), ...overrides }
  const asideName = (dir: string) => childOf(dir, `${OLD_PROGRAM_PREFIX}${deps.pid}-${deps.now()}.exe`)

  // A session may still run an older program, so a locked one stays until a later update or uninstall.
  function removeOldPrograms(dir: string): void {
    if (!deps.existsSync(dir)) return
    for (const name of deps.readdirSync(dir).filter(isOldProgram)) {
      try {
        deps.rmSync(childOf(dir, name), { force: true })
      } catch (error) {
        if (!isLocked(error)) throw error
      }
    }
  }

  /** The most recently moved-aside program: the largest time in its .kinfold-old-<pid>-<time>.exe name. */
  function newestOldProgram(dir: string): string | null {
    if (!deps.existsSync(dir)) return null
    const timeOf = (name: string) => Number(/-(\d+)\.exe$/i.exec(name)?.[1] ?? -1)
    const names = deps.readdirSync(dir).filter(isOldProgram)
    const newest = names.reduce<string | null>((best, name) => (best === null || timeOf(name) > timeOf(best) ? name : best), null)
    return newest === null ? null : childOf(dir, newest)
  }

  // An earlier replace stopped between moving the program aside and putting
  // the new one in place, so the only program has an old name. Restoring it
  // first means the swap below has a program to roll back to.
  function restoreAfterCrash(dir: string, target: string): void {
    if (deps.existsSync(target)) return
    const newest = newestOldProgram(dir)
    if (newest !== null) deps.renameSync(newest, target)
  }

  function replace(temp: string, target: string): void {
    const dir = win32.dirname(target)
    restoreAfterCrash(dir, target)
    const aside = deps.existsSync(target) ? asideName(dir) : null
    if (aside !== null) deps.renameSync(target, aside)
    try {
      deps.renameSync(temp, target)
    } catch (error) {
      if (aside !== null) {
        try {
          deps.renameSync(aside, target)
        } catch {
          // The swap's own error is the one to report; the next replace restores the aside copy.
        }
      }
      throw error
    }
    // Only now is there a new program in place, so the old copies are no longer the fallback.
    removeOldPrograms(dir)
  }

  /** Removes one entry; a locked one is renamed aside when it is not already, and its path returned. */
  function removeEntry(dir: string, name: string): string | null {
    const path = childOf(dir, name)
    try {
      deps.rmSync(path, { force: true, recursive: true })
      return null
    } catch (error) {
      if (!isLocked(error)) throw error
    }
    if (isOldProgram(name)) return path
    const aside = asideName(dir)
    try {
      deps.renameSync(path, aside)
      return aside
    } catch {
      // Still locked under its own name; it is reported as it is.
      return path
    }
  }

  function removeBinDir(dir: string): string[] {
    if (!deps.existsSync(dir)) return []
    const left = deps.readdirSync(dir).flatMap((name) => removeEntry(dir, name) ?? [])
    if (left.length === 0) deps.rmSync(dir, { force: true, recursive: true })
    return left
  }

  return { replace, removeBinDir }
}

export const windowsProgramFiles: ProgramFiles = createWindowsProgramFiles()
