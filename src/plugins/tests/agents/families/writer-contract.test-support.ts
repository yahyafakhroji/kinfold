// The contract every agent config writer keeps, checked the same way for each
// family: an install writes something, a second install plans no change, an
// uninstall gives back the bytes the user had, and an uninstall over a file
// with nothing of ours leaves it alone.

import { expect } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeBackup, writeFileAtomic } from '../../install/files'
import type { Action } from '../../install/plan'

/**
 * write: the file text after an install run over `before` (null: no file),
 * or null when the run planned no change. remove: the file text after an
 * uninstall run over `after`, or null when the uninstall deleted the file.
 * befores: the starting files to check; a missing file has no bytes to
 * restore, so it is checked for a clean, stable removal.
 */
export function assertWriterContract(
  write: (before: string | null) => string | null,
  remove: (after: string | null) => string | null,
  befores: readonly (string | null)[] = [null],
): void {
  for (const before of befores) {
    const after = write(before)
    expect(after).not.toBeNull()
    if (after === null) return
    expect(write(after)).toBeNull()
    const restored = remove(after)
    if (before === null) {
      expect(remove(restored)).toBe(restored)
      expect(write(restored)).toBe(after)
    } else {
      expect(restored).toBe(before)
      expect(remove(before)).toBe(before)
    }
  }
}

/**
 * Applies a plan of file steps synchronously and reads the file back, for the
 * write/remove callbacks above. Config writers plan only these steps.
 */
export function applyToFile(path: string, before: string | null, plan: () => readonly Action[]): { text: string | null; changed: boolean } {
  if (before === null) rmSync(path, { force: true })
  else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, before)
  }
  const actions = plan()
  for (const action of actions) applyFileAction(action)
  return { text: existsSync(path) ? readFileSync(path, 'utf8') : null, changed: actions.length > 0 }
}

function applyFileAction(action: Action): void {
  switch (action.kind) {
    case 'mkdir': return void mkdirSync(action.path, { recursive: true, mode: action.mode })
    case 'backup': return writeBackup(action.from, action.to)
    case 'write': return writeFileAtomic(action.path, action.content, action.mode)
    case 'remove': return rmSync(action.path, { force: true })
    default: throw new Error(`a config writer planned a ${action.kind} step`)
  }
}

/** write and remove callbacks over one file, from an install and an uninstall planner. */
export function fileWriter(path: string, install: () => readonly Action[], uninstall: () => readonly Action[]): {
  write: (before: string | null) => string | null
  remove: (after: string | null) => string | null
} {
  return {
    write: (before) => {
      const result = applyToFile(path, before, install)
      return result.changed ? result.text : null
    },
    remove: (after) => applyToFile(path, after, uninstall).text,
  }
}
