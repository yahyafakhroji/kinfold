// Kinfold's hook entries in an agent's JSON config, for every agent whose
// hooks live under one key as { Event: [ ... ] }. Pure merge, removal and
// inspection over the parsed file, plus the plan actions that read it, refuse
// a file that is not plain JSON, back it up before the first change and write
// it atomically. Ours are found by what the command runs (entry.ts), never by
// position: a re-run is a no-op, a moved checkout or a switch between the
// checkout and program forms replaces the old entry, and every other key,
// event and entry stays as it was. Three shapes, from each agent's docs:
//   claude:  { Event: [ { matcher?, hooks: [ { type, command, args, timeout (s), async? } ] } ] }
//   command: Codex { Event: [ { hooks: [ { type, command: "<shell>", timeout (s), async? } ] } ] },
//            Cursor { Event: [ { command: "<shell>", timeout (s) } ] } (grouped: false)
//   gemini:  { Event: [ { hooks: [ { type, command: "<shell>", timeout (ms) } ] } ] }
// Auggie takes the claude shape with its timeout in milliseconds.
// Gemini CLI's reference (geminicli.com/docs/hooks/reference, checked
// 2026-11-13) documents neither `args` nor `async`, and counts the timeout in
// milliseconds, so the gemini shape writes one shell string and no matcher,
// which matches every tool.
// Factory Droid's ~/.factory/hooks.json is that { Event: [...] } map with no
// key around it (docs.factory.com/reference/hooks-reference, 2026-11-13); a
// null hooksKey reads and writes the whole file as the map.
// The edits are exported too, so an agent whose hooks and MCP server share one
// file plans both through one json-file.ts call: one read, one write.

import { isRecord } from '../../contract/event'
import type { InstallEnv } from '../../install/env'
import { type EntryCommand, entryCommand, entryPath, entryRole, parseEntry, sameEntry } from '../../install/entry'
import type { Action } from '../../install/plan'
import type { AgentId } from '../profile'
import { type JsonEdit, type Settings, plainJsonFileActions, plainJsonFileUninstallActions } from './json-file'
import { readPlainJsonObject } from './plain-json'

export type HookShape = 'claude' | 'command' | 'gemini'

export interface HookTarget {
  /** The command an install writes, from entry.ts. */
  entry: EntryCommand
}

export type { Settings }

export type WiringState = 'yes' | 'no' | 'stale' | 'partial'

export interface JsonHooksSpec {
  shape: HookShape
  events: readonly string[]
  /** The key holding { Event: [...] }; null when the whole file is that map (Factory Droid's hooks.json). */
  hooksKey: string | null
  /** A top-level `version` the agent requires; added only when missing. */
  version?: number
  timeoutS: number
  /** The command shape only: entries sit in matcher groups (Codex) rather than straight in the event list (Cursor). */
  grouped?: boolean
  /** Events whose entry runs without blocking the agent; the claude shape also gives them matcher '*'. */
  asyncEvents?: readonly string[]
  /** A matcher on our group for these events, where the agent leaves an absent one undocumented. */
  matchers?: Readonly<Record<string, string>>
  /** Per-event timeouts in seconds, where the agent caps an event lower. */
  timeoutsS?: Readonly<Record<string, number>>
  /** The claude shape only: the agent counts `timeout` in milliseconds (Auggie). Default seconds. */
  timeoutUnit?: 's' | 'ms'
  /** Names the file in error messages. */
  label?: string
  /**
   * An entry is ours only when it names this host with --host. Without it any
   * Kinfold hook entry is ours, which is Claude Code's case: its entry has
   * never carried --host.
   */
  host?: AgentId
}

export interface JsonHooksMerge {
  settings: Settings
  changed: boolean
  added: string[]
  replaced: string[]
}

const MS_PER_S = 1000

const labelOf = (spec: JsonHooksSpec): string => spec.label ?? 'settings.json'

/** Where an event's list sits, for messages. */
const eventPath = (spec: JsonHooksSpec, event: string): string => (spec.hooksKey === null ? event : `${spec.hooksKey}.${event}`)

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const BARE_WORDS: ReadonlySet<string> = new Set(['hook', 'mcp', 'daemon'])

/** One entry as the shell string a command-string agent reads; flags, the host id and the subcommand stay bare. */
export function shellCommand(entry: EntryCommand): string {
  const words = [entry.command, ...entry.args]
  const parts: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index] ?? ''
    if (word === '--host') {
      parts.push(word, words[index + 1] ?? '')
      index += 1
      continue
    }
    parts.push(word.startsWith('--') || BARE_WORDS.has(word) ? word : shellQuote(word))
  }
  return parts.join(' ')
}

const argsOf = (entry: Readonly<Record<string, unknown>>): string[] =>
  Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []

/** The hook.ts path or program path an entry of ours runs, or null when the entry is not ours under this spec. */
export function jsonHookScript(spec: JsonHooksSpec, entry: unknown): string | null {
  if (!isRecord(entry) || typeof entry.command !== 'string') return null
  const args = argsOf(entry)
  if (entryRole(entry.command, args) !== 'hook') return null
  if (spec.host !== undefined) {
    const parsed = parseEntry(entry.command, args)
    const at = parsed?.args.indexOf('--host') ?? -1
    if (at === -1 || parsed?.args[at + 1] !== spec.host) return null
  }
  return entryPath(entry.command, args)
}

const isGrouped = (spec: JsonHooksSpec): boolean => spec.shape !== 'command' || spec.grouped === true

function hookEntry(spec: JsonHooksSpec, event: string, target: HookTarget): Record<string, unknown> {
  const timeoutS = spec.timeoutsS?.[event] ?? spec.timeoutS
  const isAsync = spec.asyncEvents?.includes(event) === true
  const { entry } = target
  if (spec.shape === 'claude') {
    const timeout = spec.timeoutUnit === 'ms' ? timeoutS * MS_PER_S : timeoutS
    return { type: 'command', command: entry.command, args: entry.args, timeout, ...(isAsync ? { async: true } : {}) }
  }
  if (spec.shape === 'gemini') return { type: 'command', command: shellCommand(entry), timeout: timeoutS * MS_PER_S }
  if (!isGrouped(spec)) return { command: shellCommand(entry), timeout: timeoutS }
  return { type: 'command', command: shellCommand(entry), timeout: timeoutS, ...(isAsync ? { async: true } : {}) }
}

/** What we put in an event's list: a group holding our entry, or the entry itself for an ungrouped agent. */
export function jsonHookItem(spec: JsonHooksSpec, event: string, target: HookTarget): Record<string, unknown> {
  const entry = hookEntry(spec, event, target)
  if (!isGrouped(spec)) return entry
  const wildcard = spec.shape === 'claude' && spec.asyncEvents?.includes(event) === true
  const matcher = spec.matchers?.[event] ?? (wildcard ? '*' : undefined)
  return matcher !== undefined ? { matcher, hooks: [entry] } : { hooks: [entry] }
}

function hooksOf(spec: JsonHooksSpec, settings: Settings): Readonly<Record<string, unknown>> {
  if (spec.hooksKey === null) return settings
  const hooks = settings[spec.hooksKey]
  if (hooks === undefined) return {}
  if (!isRecord(hooks)) throw new Error(`${labelOf(spec)} "${spec.hooksKey}" is not an object; fix it by hand first`)
  return hooks
}

function listOf(spec: JsonHooksSpec, hooks: Readonly<Record<string, unknown>>, event: string): readonly unknown[] {
  const list = hooks[event]
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error(`${labelOf(spec)} ${eventPath(spec, event)} is not a list; fix it by hand first`)
  return list
}

function entriesOf(spec: JsonHooksSpec, item: unknown): readonly unknown[] {
  if (!isGrouped(spec)) return [item]
  return isRecord(item) && Array.isArray(item.hooks) ? item.hooks : []
}

function ownEntries(spec: JsonHooksSpec, list: readonly unknown[]): unknown[] {
  return list.flatMap((item) => entriesOf(spec, item)).filter((entry) => jsonHookScript(spec, entry) !== null)
}

/** Drops our entries; a group goes only when removing ours emptied it. */
function stripOurs(spec: JsonHooksSpec, list: readonly unknown[]): unknown[] {
  if (!isGrouped(spec)) return list.filter((entry) => jsonHookScript(spec, entry) === null)
  return list.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group]
    const others = group.hooks.filter((entry) => jsonHookScript(spec, entry) === null)
    if (others.length === group.hooks.length) return [group]
    return others.length === 0 ? [] : [{ ...group, hooks: others }]
  })
}

/** The file with `hooks` as its hooks map. */
function withHooks(spec: JsonHooksSpec, settings: Settings, hooks: Readonly<Record<string, unknown>>): Settings {
  return spec.hooksKey === null ? hooks : { ...settings, [spec.hooksKey]: hooks }
}

function withVersion(spec: JsonHooksSpec, settings: Settings): Settings {
  return spec.version === undefined || settings.version !== undefined ? settings : { version: spec.version, ...settings }
}

export function mergeJsonHooks(spec: JsonHooksSpec, settings: Settings, target: HookTarget): JsonHooksMerge {
  let hooks = hooksOf(spec, settings)
  const added: string[] = []
  const replaced: string[] = []
  for (const event of spec.events) {
    const list = listOf(spec, hooks, event)
    const desired = JSON.stringify(jsonHookItem(spec, event, target))
    const ours = ownEntries(spec, list).length
    if (ours === 1 && list.some((item) => JSON.stringify(item) === desired)) continue
    ;(ours === 0 ? added : replaced).push(event)
    hooks = { ...hooks, [event]: [...stripOurs(spec, list), jsonHookItem(spec, event, target)] }
  }
  const changed = added.length > 0 || replaced.length > 0
  return { settings: changed ? withVersion(spec, withHooks(spec, settings, hooks)) : settings, changed, added, replaced }
}

/** Removes only our entries; an event list, or the hooks object itself, goes only when we emptied it. */
export function removeJsonHooks(spec: JsonHooksSpec, settings: Settings): { settings: Settings; removed: number } {
  const hooks = hooksOf(spec, settings)
  let next: Record<string, unknown> = { ...hooks }
  let removed = 0
  for (const event of Object.keys(hooks)) {
    const list = listOf(spec, hooks, event)
    const count = ownEntries(spec, list).length
    if (count === 0) continue
    removed += count
    const stripped = stripOurs(spec, list)
    const { [event]: _dropped, ...rest } = next
    next = stripped.length === 0 ? rest : { ...next, [event]: stripped }
  }
  if (removed === 0) return { settings, removed }
  if (Object.keys(next).length === 0 && spec.hooksKey !== null) {
    const { [spec.hooksKey]: _hooks, ...rest } = settings
    return { settings: rest, removed }
  }
  return { settings: withHooks(spec, settings, next), removed }
}

/** Every hook.ts or program path our entries name, across all events. */
export function jsonHookScriptsIn(spec: JsonHooksSpec, settings: Settings): string[] {
  const hooks = hooksOf(spec, settings)
  return Object.keys(hooks).flatMap((event) => ownEntries(spec, listOf(spec, hooks, event)).map((entry) => jsonHookScript(spec, entry) ?? ''))
}

function runsExpected(entry: unknown, expected: EntryCommand): boolean {
  return isRecord(entry) && typeof entry.command === 'string' && sameEntry(entry.command, argsOf(entry), expected)
}

/**
 * yes: every event runs the expected entry; stale: some entry of ours runs
 * another script, program or data folder; partial: some events missing.
 */
export function inspectJsonHooks(spec: JsonHooksSpec, settings: Settings, expected: EntryCommand): WiringState {
  const hooks = hooksOf(spec, settings)
  const all = Object.keys(hooks).flatMap((event) => ownEntries(spec, listOf(spec, hooks, event)))
  if (all.length === 0) return 'no'
  if (all.some((entry) => !runsExpected(entry, expected))) return 'stale'
  return spec.events.every((event) => ownEntries(spec, listOf(spec, hooks, event)).length > 0) ? 'yes' : 'partial'
}

/** The hook command an install writes for `host`; Claude Code's has never carried --host, and no --host still means claude-code. */
export function hookTarget(env: InstallEnv, host: AgentId): HookTarget {
  return { entry: entryCommand(env.mode, 'hook', env.dataDir, host === 'claude-code' ? undefined : host) }
}

/** Our entries merged in; a re-run with them in place changes nothing. */
export function jsonHooksEdit(spec: JsonHooksSpec, target: HookTarget, host: AgentId): JsonEdit {
  return (settings, path) => {
    const merge = mergeJsonHooks(spec, settings, target)
    if (!merge.changed) return { settings, changed: false, note: `hooks already wired in ${path}` }
    const summary = [
      merge.added.length > 0 ? `add Kinfold hooks for ${merge.added.join(', ')}` : '',
      merge.replaced.length > 0 ? `replace Kinfold hooks for ${merge.replaced.join(', ')}` : '',
    ].filter((part) => part !== '').join('; ')
    return { settings: merge.settings, changed: true, summary: `${summary} (${host})` }
  }
}

/** Only our entries out. */
export function jsonHooksRemoveEdit(spec: JsonHooksSpec): JsonEdit {
  return (settings) => {
    const result = removeJsonHooks(spec, settings)
    return result.removed === 0 ? { settings, changed: false } : { settings: result.settings, changed: true, summary: `remove ${result.removed} Kinfold hook entries` }
  }
}

export function jsonHooksActions(env: InstallEnv, path: string, spec: JsonHooksSpec, host: AgentId): Action[] {
  return plainJsonFileActions(env, path, [jsonHooksEdit(spec, hookTarget(env, host), host)], host)
}

export function jsonHooksUninstallActions(env: InstallEnv, path: string, spec: JsonHooksSpec): Action[] {
  return plainJsonFileUninstallActions(env, path, [jsonHooksRemoveEdit(spec)], spec.host ?? path)
}

/** The wiring state alone, read-only; 'unknown' when the file can't be read. */
export function jsonHooksState(env: InstallEnv, path: string, spec: JsonHooksSpec, host: AgentId): WiringState | 'unknown' {
  try {
    const file = readPlainJsonObject(path)
    return file.exists ? inspectJsonHooks(spec, file.value, hookTarget(env, host).entry) : 'no'
  } catch {
    return 'unknown'
  }
}
