// Our entries in Codex's ~/.codex/hooks.json and Cursor's ~/.cursor/hooks.json,
// as pure functions over the parsed file, following claude-hooks.ts. Both
// hosts take a shell command string, so our command is
// `'<bun>' '<checkout>/src/cli/hook.ts' --host <id>`, and ours are found by
// that hook.ts path plus the --host id, never by position: a re-run is a
// no-op, a moved checkout replaces the old path, and every other key, event
// and entry stays as it was. Shapes, from each host's docs (2026-10-25):
//   Codex:  { hooks: { Event: [ { matcher?, hooks: [ { type, command, timeout, async? } ] } ] } }
//   Cursor: { version: 1, hooks: { event: [ { command, timeout, matcher? } ] } }
// Codex has no wildcard matcher documented, so our groups carry none, which
// matches every tool. Codex caps SessionEnd hooks at 3 s.

import { isRecord } from '../contract/event'
import type { HookTarget, Settings, WiringState } from './claude-hooks'

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
const QUOTED = /'((?:[^']|'\\'')*\/src\/cli\/hook\.ts)'\s+--host\s+([a-z][a-z0-9-]*)(?:\s|$)/
const BARE = /(?:^|\s)(\/\S*\/src\/cli\/hook\.ts)\s+--host\s+([a-z][a-z0-9-]*)(?:\s|$)/

export function samCommand(target: HookTarget, host: CommandHookHost): string {
  return `${shellQuote(target.bunPath)} ${shellQuote(target.hookScript)} --host ${host}`
}

/** The hook.ts path an entry of ours runs for `host`, or null when the entry is not ours. */
export function samCommandScript(entry: unknown, host: CommandHookHost): string | null {
  if (!isRecord(entry) || typeof entry.command !== 'string') return null
  const quoted = QUOTED.exec(entry.command)
  if (quoted !== null) return quoted[2] === host ? (quoted[1] ?? '').replace(/'\\''/g, "'") : null
  const bare = BARE.exec(entry.command)
  return bare !== null && bare[2] === host ? (bare[1] ?? null) : null
}

export function samItem(spec: CommandHookSpec, event: string, target: HookTarget): Record<string, unknown> {
  const entry = spec.entry(event, samCommand(target, spec.host))
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

/** yes: every event runs the current script; stale: some entry names another path; partial: some events missing. */
export function inspectHostHooks(spec: CommandHookSpec, settings: Settings, hookScript: string): WiringState {
  const hooks = hooksOf(spec, settings)
  const all = Object.keys(hooks).flatMap((event) => samScripts(spec, listOf(spec, hooks, event)))
  if (all.length === 0) return 'no'
  if (all.some((script) => script !== hookScript)) return 'stale'
  return spec.events.every((event) => samScripts(spec, listOf(spec, hooks, event)).includes(hookScript)) ? 'yes' : 'partial'
}
