// A file Kinfold writes whole and owns whole: Cline's per-event hook scripts
// and Kiro's ~/.kiro/hooks/kinfold.json. Nothing else lives in it, so there is
// nothing to merge and no backup to keep: install writes it, uninstall removes
// it. A file by that name that is not ours (judged by what it runs, never by
// its name) is never overwritten or removed. An empty file holds nothing and
// is treated as missing. An executable file that lost its exec bits is stale,
// since the agent would not run it.

import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { InstallEnv } from '../../install/env'
import { readTextOrNull } from '../../install/files'
import type { Action } from '../../install/plan'
import { osOf } from '../../platform/platform'

export type OwnedFileState = 'no' | 'yes' | 'stale' | 'foreign'

export interface OwnedFileSpec {
  path: string
  /** What an install writes. */
  content: string
  mode: number
  /** True when the text is a file of ours, current or not. */
  isOurs(text: string): boolean
  /** What the file is, for messages: "Kinfold hook file". */
  noun: string
}

const DIR_MODE = 0o755
const EXEC_BITS = 0o111

function lostExecBits(env: InstallEnv, spec: OwnedFileSpec): boolean {
  if ((spec.mode & EXEC_BITS) === 0 || osOf(env.platform) === 'windows') return false
  return (statSync(spec.path).mode & EXEC_BITS) === 0
}

export function ownedFileState(env: InstallEnv, spec: OwnedFileSpec): OwnedFileState {
  const text = readTextOrNull(spec.path)
  if (text === null || text.trim() === '') return 'no'
  if (text === spec.content) return lostExecBits(env, spec) ? 'stale' : 'yes'
  return spec.isOurs(text) ? 'stale' : 'foreign'
}

/** Our file written or refreshed; one by our name that is not ours is named and left alone. */
export function ownedFileActions(env: InstallEnv, spec: OwnedFileSpec, label: string): Action[] {
  const state = ownedFileState(env, spec)
  if (state === 'yes') return []
  if (state === 'foreign') {
    env.out(`${label}: ${spec.path} is not a ${spec.noun}; left alone`)
    return []
  }
  const dir = dirname(spec.path)
  return [
    ...(existsSync(dir) ? [] : [{ kind: 'mkdir', path: dir, mode: DIR_MODE } as const]),
    { kind: 'write', path: spec.path, content: spec.content, mode: spec.mode, summary: state === 'stale' ? `replace the stale ${spec.noun}` : `add the ${spec.noun}` },
  ]
}

export function ownedFileUninstallActions(env: InstallEnv, spec: OwnedFileSpec, label: string): Action[] {
  const state = ownedFileState(env, spec)
  if (state === 'foreign') env.out(`${label}: ${spec.path} is not a ${spec.noun}; left alone`)
  return state === 'yes' || state === 'stale' ? [{ kind: 'remove', path: spec.path, summary: `the ${spec.noun}` }] : []
}

/** Several owned files read as one wiring state; a foreign one counts as missing. */
export function ownedFilesState(env: InstallEnv, specs: readonly OwnedFileSpec[]): 'yes' | 'no' | 'stale' | 'partial' {
  const states = specs.map((spec) => ownedFileState(env, spec))
  if (states.every((state) => state === 'yes')) return 'yes'
  if (states.includes('stale')) return 'stale'
  return states.some((state) => state === 'yes') ? 'partial' : 'no'
}
