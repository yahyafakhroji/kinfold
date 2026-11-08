// Our entries in Codex's ~/.codex/hooks.json and Cursor's ~/.cursor/hooks.json,
// as pure functions over the parsed file, following claude-hooks.ts. Both
// hosts take one shell command string, so our entry is rendered from the
// command entry.ts builds: the checkout's bun on src/cli/hook.ts with
// `--host <id>`, or the installed program with --data-dir before `hook` and
// the host. Ours are found by what the command runs, never by position: a
// re-run is a no-op, a moved checkout or a switch between the two forms
// replaces the old entry, and every other key, event and entry stays as it
// was. Shapes, from each host's docs (2026-10-25):
//   Codex:  { hooks: { Event: [ { matcher?, hooks: [ { type, command, timeout, async? } ] } ] } }
//   Cursor: { version: 1, hooks: { event: [ { command, timeout, matcher? } ] } }
// Codex has no wildcard matcher documented, so our groups carry none, which
// matches every tool. Codex caps SessionEnd hooks at 3 s.

import { isRecord } from '../contract/event'
import type { HookTarget, Settings, WiringState } from './claude-hooks'
import { entryPath, entryRole, parseEntry, sameEntry, type EntryCommand } from './entry'

export type CommandHookHost = 'codex' | 'cursor'

export interface CommandHookSpec {
  host: CommandHookHost
  /** File label for error messages. */
  label: string
  events: readonly string[]
  /** Codex nests entries in matcher groups like Claude Code; Cursor lists entries directly. */
  grouped: boolean
  entry: (event: string, command: string) => Record<string, unknown>
  /** Top-level keys the host requires; added only when missing. */
  required: Readonly<Record<string, unknown>>
}

export const HOOK_TIMEOUT_S = 10
const CODEX_SESSION_END_TIMEOUT_S = 3

export const CODEX_HOOK_SPEC: CommandHookSpec = {
  host: 'codex',
  label: 'Codex hooks.json',
  events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
  grouped: true,
  entry: (event, command) => ({
    type: 'command',
    command,
    timeout: event === 'SessionEnd' ? CODEX_SESSION_END_TIMEOUT_S : HOOK_TIMEOUT_S,
    ...(event === 'PostToolUse' ? { async: true } : {}),
  }),
  required: {},
}

export const CURSOR_HOOK_SPEC: CommandHookSpec = {
  host: 'cursor',
  label: 'Cursor hooks.json',
  events: ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'afterAgentResponse', 'stop', 'sessionEnd'],
  grouped: false,
  entry: (_event, command) => ({ command, timeout: HOOK_TIMEOUT_S }),
  required: { version: 1 },
}

export interface HostHooksMerge {
  settings: Settings
  changed: boolean
  added: string[]
  replaced: string[]
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const BARE_WORDS: ReadonlySet<string> = new Set(['hook', 'mcp', 'daemon'])

/** One entry as the shell string these hosts read; flags, the host id and the subcommand stay bare. */
function renderCommand(entry: EntryCommand): string {
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

export function samCommand(target: HookTarget): string {
  return renderCommand(target.entry)
}

/** The hook.ts path or program path an entry of ours runs for `host`, or null when the entry is not ours. */
export function samCommandScript(entry: unknown, host: CommandHookHost): string | null {
  if (!isRecord(entry) || typeof entry.command !== 'string') return null
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []
  if (entryRole(entry.command, args) !== 'hook') return null
  const parsed = parseEntry(entry.command, args)
  const at = parsed?.args.indexOf('--host') ?? -1
  return at !== -1 && parsed?.args[at + 1] === host ? entryPath(entry.command, args) : null
}

export function samItem(spec: CommandHookSpec, event: string, target: HookTarget): Record<string, unknown> {
  const entry = spec.entry(event, samCommand(target))
  return spec.grouped ? { hooks: [entry] } : entry
}

function hooksOf(spec: CommandHookSpec, settings: Settings): Readonly<Record<string, unknown>> {
  if (settings.hooks === undefined) return {}
  if (!isRecord(settings.hooks)) throw new Error(`${spec.label} "hooks" is not an object; fix it by hand first`)
  return settings.hooks
}

function listOf(spec: CommandHookSpec, hooks: Readonly<Record<string, unknown>>, event: string): readonly unknown[] {
  const list = hooks[event]
  if (list === undefined) return []
  if (!Array.isArray(list)) throw new Error(`${spec.label} hooks.${event} is not a list; fix it by hand first`)
  return list
}

function entriesOf(spec: CommandHookSpec, item: unknown): readonly unknown[] {
  if (!spec.grouped) return [item]
  return isRecord(item) && Array.isArray(item.hooks) ? item.hooks : []
}

function samScripts(spec: CommandHookSpec, list: readonly unknown[]): string[] {
  return list.flatMap((item) => entriesOf(spec, item)).map((entry) => samCommandScript(entry, spec.host)).filter((script): script is string => script !== null)
}

/** Drops our entries; a Codex group goes only when removing ours emptied it. */
function stripSam(spec: CommandHookSpec, list: readonly unknown[]): unknown[] {
  if (!spec.grouped) return list.filter((entry) => samCommandScript(entry, spec.host) === null)
  return list.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group]
    const others = group.hooks.filter((entry) => samCommandScript(entry, spec.host) === null)
    if (others.length === group.hooks.length) return [group]
    return others.length === 0 ? [] : [{ ...group, hooks: others }]
  })
}

function withRequired(spec: CommandHookSpec, settings: Settings): Settings {
  const missing = Object.entries(spec.required).filter(([key]) => settings[key] === undefined)
  return missing.length === 0 ? settings : { ...Object.fromEntries(missing), ...settings }
}

export function mergeHostHooks(spec: CommandHookSpec, settings: Settings, target: HookTarget): HostHooksMerge {
  let hooks = hooksOf(spec, settings)
  const added: string[] = []
  const replaced: string[] = []
  for (const event of spec.events) {
    const list = listOf(spec, hooks, event)
    const desired = JSON.stringify(samItem(spec, event, target))
    const scripts = samScripts(spec, list)
    if (scripts.length === 1 && list.some((item) => JSON.stringify(item) === desired)) continue
    ;(scripts.length === 0 ? added : replaced).push(event)
    hooks = { ...hooks, [event]: [...stripSam(spec, list), samItem(spec, event, target)] }
  }
  const changed = added.length > 0 || replaced.length > 0
  return { settings: changed ? withRequired(spec, { ...settings, hooks }) : settings, changed, added, replaced }
}

/** Removes only our entries; an event list goes only when we emptied it. The hooks object itself stays. */
export function removeHostHooks(spec: CommandHookSpec, settings: Settings): { settings: Settings; removed: number } {
  const hooks = hooksOf(spec, settings)
  let next: Record<string, unknown> = { ...hooks }
  let removed = 0
  for (const event of Object.keys(hooks)) {
    const list = listOf(spec, hooks, event)
    const count = samScripts(spec, list).length
    if (count === 0) continue
    removed += count
    const stripped = stripSam(spec, list)
    const { [event]: _dropped, ...rest } = next
    next = stripped.length === 0 ? rest : { ...next, [event]: stripped }
  }
  return removed === 0 ? { settings, removed } : { settings: { ...settings, hooks: next }, removed }
}

function runsExpected(entry: unknown, expected: EntryCommand): boolean {
  if (!isRecord(entry) || typeof entry.command !== 'string') return false
  const args = Array.isArray(entry.args) ? entry.args.filter((arg): arg is string => typeof arg === 'string') : []
  return sameEntry(entry.command, args, expected)
}

function ownEntries(spec: CommandHookSpec, list: readonly unknown[]): unknown[] {
  return list.flatMap((item) => entriesOf(spec, item)).filter((entry) => samCommandScript(entry, spec.host) !== null)
}

/**
 * yes: every event runs the expected entry; stale: some entry of ours runs
 * another script, program or data folder; partial: some events missing.
 */
export function inspectHostHooks(spec: CommandHookSpec, settings: Settings, expected: EntryCommand): WiringState {
  const hooks = hooksOf(spec, settings)
  const all = Object.keys(hooks).flatMap((event) => ownEntries(spec, listOf(spec, hooks, event)))
  if (all.length === 0) return 'no'
  if (all.some((entry) => !runsExpected(entry, expected))) return 'stale'
  return spec.events.every((event) => ownEntries(spec, listOf(spec, hooks, event)).length > 0) ? 'yes' : 'partial'
}
