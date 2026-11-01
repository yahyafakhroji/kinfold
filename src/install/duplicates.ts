// Project-level SAM wiring next to the per-user install captures every event
// twice. install and status look in the current directory's .claude settings
// and .opencode/plugins and name what they find. Read-only: project files are
// the user's, so the fix is theirs to make. A file that does not parse is
// skipped; it cannot be wired.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { samScriptsIn } from './claude-hooks'
import { readJsonObject } from './files'
import { shimTarget } from './opencode-shim'

const PROJECT_SETTINGS = [join('.claude', 'settings.local.json'), join('.claude', 'settings.json')]
const PROJECT_PLUGINS_DIR = join('.opencode', 'plugins')
const PLUGIN_FILE = /\.(js|mjs|ts)$/

function hasSamHooks(path: string): boolean {
  try {
    const file = readJsonObject(path)
    return file.exists && samScriptsIn(file.value).length > 0
  } catch {
    return false
  }
}

function samShims(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => PLUGIN_FILE.test(name))
    .map((name) => join(dir, name))
    .filter((path) => shimTarget(readFileSync(path, 'utf8')) !== null)
}

/** Absolute paths of SAM wiring under `cwd`; `userFiles` (the per-user install's own files) never count. */
export function findDuplicateWiring(cwd: string, userFiles: readonly string[]): string[] {
  const own = new Set(userFiles.map((path) => resolve(path)))
  const settings = PROJECT_SETTINGS.map((name) => join(cwd, name)).filter(hasSamHooks)
  return [...settings, ...samShims(join(cwd, PROJECT_PLUGINS_DIR))].filter((path) => !own.has(resolve(path)))
}

export function duplicateWarning(files: readonly string[]): string[] {
  if (files.length === 0) return []
  return [
    'warning: this directory also wires shared-agent-memory, so its events would be captured twice:',
    ...files.map((file) => `  ${file}`),
    '  remove those entries (or files) yourself; sam never edits project files.',
  ]
}
