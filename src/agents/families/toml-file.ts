// The plan around toml-config.ts for one TOML config file: read it (a missing
// file is empty), refuse one outside the subset toml-config reads, merge our
// [[hooks]] tables, back the original up before the first change and write it
// atomically. Uninstall takes out only our tables. A file it can't read skips
// this agent with the reason; every other agent still installs.

import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { type InstallEnv, errorMessage } from '../../install/env'
import { plannedBackup, readTextOrNull } from '../../install/files'
import type { Action } from '../../install/plan'
import type { AgentId } from '../profile'
import { type WiringState, hookTarget } from './json-hooks'
import { type TomlDoc, mergeTomlHooks, readTomlConfig, removeTomlOurs, renderToml } from './toml-config'

const DIR_MODE = 0o755
const FILE_MODE = 0o644

interface TomlFile {
  text: string | null
  doc: TomlDoc
}

function readFile(path: string): TomlFile {
  const text = readTextOrNull(path)
  const doc = readTomlConfig(text ?? '')
  if (doc === null) throw new Error(`${path} uses TOML Kinfold does not read (inline tables, multi-line strings or dates); leaving it untouched`)
  return { text, doc }
}

function plan(env: InstallEnv, path: string, file: TomlFile, next: string, summary: string): Action[] {
  const backup = file.text === null ? null : plannedBackup(path, env.now())
  const mode = file.text === null ? FILE_MODE : statSync(path).mode & 0o777
  return [
    ...(existsSync(dirname(path)) ? [] : [{ kind: 'mkdir', path: dirname(path), mode: DIR_MODE } as const]),
    ...(backup !== null ? [{ kind: 'backup', from: path, to: backup } as const] : []),
    { kind: 'write', path, content: next, mode, summary },
  ]
}

/** `alongside` names what the agent still gets when only this file is refused, so the line doesn't read as the whole agent skipped. */
function guarded(env: InstallEnv, host: AgentId, run: () => Action[], alongside?: string): Action[] {
  try {
    return run()
  } catch (error: unknown) {
    env.out(alongside === undefined ? `${host}: skipped; ${errorMessage(error)}` : `${host}: hooks skipped (${errorMessage(error)}); ${alongside}`)
    return []
  }
}

/** Our [[hooks]] tables for `events`; nothing is planned when they are already in place. */
export function tomlHooksActions(env: InstallEnv, path: string, events: readonly string[], host: AgentId, alongside?: string): Action[] {
  return guarded(env, host, () => {
    const file = readFile(path)
    const next = renderToml(mergeTomlHooks(file.doc, events, hookTarget(env, host)))
    if (next === (file.text ?? '')) {
      env.out(`${host}: hooks already wired in ${path}`)
      return []
    }
    return plan(env, path, file, next, `Kinfold hooks for ${events.join(', ')} (${host}); every other table kept`)
  }, alongside)
}

export function tomlHooksUninstallActions(env: InstallEnv, path: string, host: AgentId): Action[] {
  return guarded(env, host, () => {
    const file = readFile(path)
    if (file.text === null) return []
    const next = renderToml(removeTomlOurs(file.doc))
    return next === file.text ? [] : plan(env, path, file, next, 'remove the Kinfold hooks; every other table kept')
  })
}

/** Read-only; 'unknown' when the file can't be read. */
export function tomlHooksState(env: InstallEnv, path: string, events: readonly string[], host: AgentId): WiringState | 'unknown' {
  try {
    const file = readFile(path)
    const current = renderToml(file.doc)
    if (renderToml(mergeTomlHooks(file.doc, events, hookTarget(env, host))) === current) return 'yes'
    return renderToml(removeTomlOurs(file.doc)) === current ? 'no' : 'stale'
  } catch {
    return 'unknown'
  }
}
