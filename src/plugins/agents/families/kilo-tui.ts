// The recall toast in Kilo Code. Kilo's TUI loads only the plugins listed
// under `plugin` in ~/.config/kilo/tui.json (it does not scan a folder for
// them, unlike OpenCode 2.x), each a file whose default export is
// { id, tui }, and hands `tui` an api with `ui.toast` (Kilo CLI 7.8.27,
// @kilocode/plugin/tui; a toast was seen live). So Kinfold writes one file,
// ~/.config/kilo/kinfold-recall/tui.js, and adds its path to that list:
//   tui.js  asks the Kinfold daemon once a second for what Kilo sent (GET
//           /watch) and toasts each prompt's recall line, and each new
//           session's first-screen list (opencode-tui.ts holds the shared part)
// tui.json is the user's file: it gets a backup before the first change, our
// entry is the one string that names our file, and uninstall takes out only
// that. A tui.json that is not plain JSON is left alone and the toast is
// skipped, since capture and memory do not depend on it.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type InstallEnv, platformOf } from '../../../resources/install-plan/env'
import { describeTextChange, existingBackups, readTextOrNull } from '../../../resources/install-plan/files'
import type { Action } from '../../../resources/install-plan/plan'
import { LEGACY_SHIM_MARKER, SHIM_MARKER } from '../../../system/names'
import { type JsonEdit, type Settings, plainJsonFileActions, plainJsonFileUninstallActions } from './json-file'
import { readPlainJsonObject } from './plain-json'
import { OPENCODE_TUI_PLUGIN_ID, recallWatcherSource } from './opencode-tui'

const DIR_MODE = 0o755
const FILE_MODE = 0o644

export const KILO_TUI_DIR = 'kinfold-recall'
export const KILO_TUI_FILE = 'tui.js'
const LABEL = 'kilo-code tui.json'

const onWindows = (env: InstallEnv): boolean => platformOf(env).os === 'windows'

const kiloDir = (env: InstallEnv): string => join(env.homeDir, '.config', 'kilo')

export function kiloTuiPath(env: InstallEnv): string {
  return join(kiloDir(env), KILO_TUI_DIR, KILO_TUI_FILE)
}

export function kiloTuiConfigPath(env: InstallEnv): string {
  return join(kiloDir(env), 'tui.json')
}

const isOurs = (text: string): boolean => {
  const first = text.split('\n', 1)[0] ?? ''
  return first.startsWith(`// ${SHIM_MARKER}:`) || first.startsWith(`// ${LEGACY_SHIM_MARKER}:`)
}

/** The TUI module Kilo loads: `default export { id, tui }`, nothing imported from Kilo, so it loads in whatever build runs it. */
export function kiloTuiContent(dataDir: string): string {
  return `// ${SHIM_MARKER}: written by \`kinfold install\`, removed by \`kinfold uninstall\`.
// Shows what Kinfold recalled as toasts: a list when a session starts, a line for each prompt. For the user only: nothing here reaches a model.
${recallWatcherSource(dataDir, 'kilo-code')}
export default {
  id: ${JSON.stringify(OPENCODE_TUI_PLUGIN_ID)},
  async tui(api) {
    // Kilo's toast takes no session: it shows in whatever the user is looking at.
    const stop = startRecallToasts(({ sessionID: _session, ...toast }) => api.ui.toast(toast));
    api.lifecycle?.onDispose?.(stop);
  },
};
`
}

function pluginList(settings: Settings): unknown[] {
  return Array.isArray(settings.plugin) ? settings.plugin : []
}

/** An entry is ours when it names our file, as a string or as the first item of [spec, options]. */
function namesOurs(entry: unknown, path: string, windows: boolean): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry
  if (typeof spec !== 'string') return false
  let given = spec
  if (spec.startsWith('file:')) {
    try {
      given = fileURLToPath(spec)
    } catch {
      return false
    }
  }
  // A path may be written with either separator; on Windows the case of a name does not matter either.
  const plain = (text: string): string => (windows ? text.replaceAll('\\', '/').toLowerCase() : text.replaceAll('\\', '/'))
  return plain(given) === plain(path)
}

const addEntry = (path: string, windows: boolean): JsonEdit => (settings, file) => {
  if (settings.plugin !== undefined && !Array.isArray(settings.plugin)) return { refuse: `${file} has a "plugin" that is not a list; left untouched` }
  const list = pluginList(settings)
  if (list.some((entry) => namesOurs(entry, path, windows))) return { settings, changed: false }
  return { settings: { ...settings, plugin: [...list, path] }, changed: true, summary: 'add the Kinfold recall toast to "plugin"' }
}

const removeEntry = (path: string, windows: boolean): JsonEdit => (settings) => {
  const list = pluginList(settings)
  if (!list.some((entry) => namesOurs(entry, path, windows))) return { settings, changed: false }
  const rest = list.filter((entry) => !namesOurs(entry, path, windows))
  const { plugin: _plugin, ...others } = settings
  return { settings: rest.length === 0 ? others : { ...others, plugin: rest }, changed: true, summary: 'take the Kinfold recall toast out of "plugin"' }
}

/** The toast's file and its tui.json entry, each only when missing or out of date. A file by our name that is not ours, or a tui.json that can't be merged, skips the toast. */
export function kiloTuiInstallActions(env: InstallEnv): Action[] {
  const path = kiloTuiPath(env)
  const before = readTextOrNull(path)
  if (before !== null && before.trim() !== '' && !isOurs(before)) {
    env.out(`kilo-code: ${path} is not a Kinfold file; the recall toast is not installed`)
    return []
  }
  const config = kiloTuiConfigPath(env)
  try {
    readPlainJsonObject(config)
  } catch (error: unknown) {
    env.out(`kilo-code: the recall toast is not installed; ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
  const content = kiloTuiContent(env.dataDir)
  const dir = join(kiloDir(env), KILO_TUI_DIR)
  const file: Action[] = before === content ? [] : [
    ...(existsSync(dir) ? [] : [{ kind: 'mkdir', path: dir, mode: DIR_MODE } as const]),
    { kind: 'write', path, content, mode: FILE_MODE, summary: describeTextChange(before, content) ?? 'unchanged' },
  ]
  return [...file, ...plainJsonFileActions(env, config, [addEntry(path, onWindows(env))], LABEL)]
}

/** Our entry out of tui.json (a file Kinfold created goes once it holds nothing else), our file, and the folder when nothing else is in it. */
export function kiloTuiUninstallActions(env: InstallEnv): Action[] {
  const path = kiloTuiPath(env)
  const config = kiloTuiConfigPath(env)
  // Install backs up a tui.json that was there before its first change, and makes none for one it creates:
  // with a backup the file is the user's and gets its bytes back; without one Kinfold made it and it goes.
  const created = existingBackups(config).length === 0
  const planned = plainJsonFileUninstallActions(env, config, [removeEntry(path, onWindows(env))], LABEL, created ? [] : undefined)
  // A file Kinfold made and now removes needs no backup; one left behind would make the next install's file look like the user's.
  const removed = planned.some((action) => action.kind === 'remove' && action.path === config)
  const entry = removed ? planned.filter((action) => action.kind !== 'backup') : planned
  const text = readTextOrNull(path)
  if (text === null || !isOurs(text)) return entry
  const dir = join(kiloDir(env), KILO_TUI_DIR)
  const others = readdirSync(dir).filter((name) => name !== KILO_TUI_FILE)
  return [
    ...entry,
    { kind: 'remove', path, summary: 'the Kinfold recall toast for Kilo Code' },
    ...(others.length === 0 ? [{ kind: 'remove', path: dir, summary: 'the folder of the Kinfold recall toast for Kilo Code', recursive: true } as const] : []),
  ]
}

/** For status: whether the toast is in place. */
export function kiloTuiLine(env: InstallEnv): string {
  const text = readTextOrNull(kiloTuiPath(env))
  if (text === null || !isOurs(text)) return 'recall toast no'
  let listed = false
  try {
    const config = readPlainJsonObject(kiloTuiConfigPath(env))
    listed = config.exists && pluginList(config.value).some((entry) => namesOurs(entry, kiloTuiPath(env), onWindows(env)))
  } catch {
    // An unreadable tui.json lists nothing we can see.
  }
  if (!listed) return `recall toast not listed in ${kiloTuiConfigPath(env)}`
  return text === kiloTuiContent(env.dataDir) ? 'recall toast yes' : 'recall toast stale'
}
