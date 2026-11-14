// Planning, removal and inspection of our hooks in ~/.claude/settings.json,
// shaped like host-wiring.ts does it for the other agents: read the file (an
// unparseable one stops the install untouched), merge ours in with
// claude-hooks.ts, back the original up before the first change, write it
// atomically. Uninstall takes only our entries out.

import { existsSync } from 'node:fs'
import { type WiringState, inspectSamHooks, mergeSamHooks, removeSamHooks } from './claude-hooks'
import { type InstallEnv, errorMessage, installPaths } from './env'
import { entryCommand } from './entry'
import { plannedBackup, readJsonObject, serializeJson } from './files'
import type { Action } from './plan'

const DIR_MODE = 0o755
const FILE_MODE = 0o644

export function claudeHookInstallActions(env: InstallEnv): Action[] {
  const paths = installPaths(env)
  const file = readJsonObject(paths.claudeSettings)
  const merge = mergeSamHooks(file.exists ? file.value : {}, { entry: entryCommand(env.mode, 'hook', env.dataDir) })
  if (!merge.changed) {
    env.out(`claude-code: hooks already wired in ${paths.claudeSettings}`)
    return []
  }
  const backup = plannedBackup(paths.claudeSettings, env.now())
  const parts = [
    merge.added.length > 0 ? `add Kinfold hooks for ${merge.added.join(', ')}` : '',
    merge.replaced.length > 0 ? `replace Kinfold hooks for ${merge.replaced.join(', ')}` : '',
    'every other key and hook kept',
  ].filter((part) => part !== '')
  return [
    ...(existsSync(paths.claudeDir) ? [] : [{ kind: 'mkdir', path: paths.claudeDir, mode: DIR_MODE } as const]),
    ...(backup !== null ? [{ kind: 'backup', from: paths.claudeSettings, to: backup } as const] : []),
    { kind: 'write', path: paths.claudeSettings, content: serializeJson(merge.settings, file.exists ? file.text : null), mode: file.exists ? file.mode : FILE_MODE, summary: parts.join('; ') },
  ]
}

export function claudeHookUninstallActions(env: InstallEnv): Action[] {
  const path = installPaths(env).claudeSettings
  const file = readJsonObject(path)
  if (!file.exists) return []
  const result = removeSamHooks(file.value)
  if (result.removed === 0) return []
  const backup = plannedBackup(path, env.now())
  return [
    ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
    { kind: 'write', path, content: serializeJson(result.settings, file.text), mode: file.mode, summary: `remove ${result.removed} Kinfold hook entries; every other key and hook kept` },
  ]
}

/** The wiring state alone, read-only; 'unknown' when settings.json cannot be read. */
export function claudeHookState(env: InstallEnv): WiringState | 'unknown' {
  try {
    const file = readJsonObject(installPaths(env).claudeSettings)
    return file.exists ? inspectSamHooks(file.value, entryCommand(env.mode, 'hook', env.dataDir)) : 'no'
  } catch {
    return 'unknown'
  }
}

/** For status: yes/no/stale/partial with the file, read-only. */
export function claudeHookLine(env: InstallEnv): string {
  const paths = installPaths(env)
  try {
    const file = readJsonObject(paths.claudeSettings)
    const state = file.exists ? inspectSamHooks(file.value, entryCommand(env.mode, 'hook', env.dataDir)) : 'no (no settings.json)'
    return `${state} in ${paths.claudeSettings}`
  } catch (error: unknown) {
    return `unknown (${errorMessage(error)}) in ${paths.claudeSettings}`
  }
}
