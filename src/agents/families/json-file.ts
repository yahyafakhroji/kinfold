// One agent config file, one plan: a single read, every edit applied in
// order to the parsed value, then at most one backup and one atomic write.
// A plan's write carries content computed when it was planned, so two
// planners over the same file (an agent whose hooks and MCP server share
// settings.json) would each start from the original and the second write
// would drop the first one's change. Profiles pass all their edits for a
// file to one call instead.

import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { type InstallEnv, errorMessage } from '../../install/env'
import { plannedBackup, serializeJson } from '../../install/files'
import type { Action } from '../../install/plan'
import { readPlainJsonObject, uninstallText } from './plain-json'

export type Settings = Readonly<Record<string, unknown>>

export type JsonEditResult =
  | {
    settings: Settings
    changed: boolean
    /** What the change does, for the plan line. */
    summary?: string
    /** Said when nothing changed or something was left alone. */
    note?: string
  }
  | { refuse: string }

/** A pure change to the parsed file; `path` is for messages only. A refusal or a throw skips the whole file. */
export type JsonEdit = (settings: Settings, path: string) => JsonEditResult

const DIR_MODE = 0o755
const FILE_MODE = 0o644

type Folded = { settings: Settings; changed: boolean; summaries: string[] } | { refuse: string }

function fold(env: InstallEnv, start: Settings, path: string, edits: readonly JsonEdit[], label: string): Folded {
  let settings = start
  let changed = false
  const summaries: string[] = []
  for (const edit of edits) {
    const result = edit(settings, path)
    if ('refuse' in result) return result
    if (result.note !== undefined) env.out(`${label}: ${result.note}`)
    if (!result.changed) continue
    settings = result.settings
    changed = true
    if (result.summary !== undefined) summaries.push(result.summary)
  }
  return { settings, changed, summaries }
}

function planOrSkip(env: InstallEnv, label: string, plan: () => Action[]): Action[] {
  try {
    return plan()
  } catch (error: unknown) {
    env.out(`${label}: skipped; ${errorMessage(error)}`)
    return []
  }
}

/** Install: the edits over the file as it is (missing reads as {}); nothing is planned when none changes it. */
export function plainJsonFileActions(env: InstallEnv, path: string, edits: readonly JsonEdit[], label: string): Action[] {
  return planOrSkip(env, label, () => {
    const file = readPlainJsonObject(path)
    const folded = fold(env, file.exists ? file.value : {}, path, edits, label)
    if ('refuse' in folded) throw new Error(folded.refuse)
    if (!folded.changed) return []
    const backup = plannedBackup(path, env.now())
    return [
      ...(existsSync(dirname(path)) ? [] : [{ kind: 'mkdir', path: dirname(path), mode: DIR_MODE } as const]),
      ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
      {
        kind: 'write',
        path,
        content: serializeJson(folded.settings, file.exists ? file.text : null),
        mode: file.exists ? file.mode : FILE_MODE,
        summary: [...folded.summaries, 'every other key and entry kept'].join('; '),
      },
    ]
  })
}

/**
 * Uninstall: the removal edits over an existing file; the original bytes go
 * back when only ours were ever added. A file named for Kinfold alone
 * (`removeWhenOnly` lists the keys it holds besides ours) is deleted once
 * taking ours out leaves nothing but those keys.
 */
export function plainJsonFileUninstallActions(env: InstallEnv, path: string, edits: readonly JsonEdit[], label: string, removeWhenOnly?: readonly string[]): Action[] {
  return planOrSkip(env, label, () => {
    const file = readPlainJsonObject(path)
    if (!file.exists) return []
    const folded = fold(env, file.value, path, edits, label)
    if ('refuse' in folded) throw new Error(folded.refuse)
    if (!folded.changed) return []
    const backup = plannedBackup(path, env.now())
    const emptied = removeWhenOnly !== undefined && Object.keys(folded.settings).every((key) => removeWhenOnly.includes(key))
    if (emptied) return [...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []), { kind: 'remove', path, summary: 'the Kinfold file, which holds nothing else' }]
    return [
      ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
      { kind: 'write', path, content: uninstallText(path, folded.settings, file.text), mode: file.mode, summary: [...folded.summaries, 'every other key and entry kept'].join('; ') },
    ]
  })
}
