// Our entries in Claude Code's settings.json, as pure functions over the
// parsed file. Our entry has the shape this project's .claude/settings.local.json
// proved live: the absolute bun as `command`, the absolute src/cli/hook.ts as
// the only arg, timeout 10, async for the tool events. Ours are found by the
// hook.ts path, never by position, so a re-run is a no-op, a moved checkout
// replaces the old path, and every other key, event and hook stays as it was.

import { isRecord } from '../contract/event'

export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'] as const
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]

const TOOL_EVENTS: readonly ClaudeHookEvent[] = ['PostToolUse', 'PostToolUseFailure']
export const HOOK_TIMEOUT_S = 10
const HOOK_SCRIPT_SUFFIX = '/src/cli/hook.ts'
/** The older string form: "bun /path/src/cli/hook.ts". */
const COMMAND_STRING = /(^|\/)bun\s+("?)(\/\S*\/src\/cli\/hook\.ts)\2(\s|$)/

export interface HookTarget {
  bunPath: string
  hookScript: string
}

export type Settings = Readonly<Record<string, unknown>>

export interface HooksMerge {
  settings: Settings
  changed: boolean
  added: ClaudeHookEvent[]
  replaced: ClaudeHookEvent[]
}

export type WiringState = 'yes' | 'no' | 'stale' | 'partial'

export function samHookGroup(event: ClaudeHookEvent, target: HookTarget): Record<string, unknown> {
  const isTool = TOOL_EVENTS.includes(event)
  const hook = { type: 'command', command: target.bunPath, args: [target.hookScript], timeout: HOOK_TIMEOUT_S, ...(isTool ? { async: true } : {}) }
  return isTool ? { matcher: '*', hooks: [hook] } : { hooks: [hook] }
}

/** The hook.ts path a SAM entry runs, or null when the entry is not ours. */
export function samHookScript(entry: unknown): string | null {
  if (!isRecord(entry) || typeof entry.command !== 'string') return null
  const args = entry.args
  if (Array.isArray(args) && args.length === 1 && typeof args[0] === 'string' && args[0].endsWith(HOOK_SCRIPT_SUFFIX)) {
    return /(^|\/)bun$/.test(entry.command) ? args[0] : null
  }
  return COMMAND_STRING.exec(entry.command)?.[3] ?? null
}

function groupsOf(hooks: Readonly<Record<string, unknown>>, event: string): readonly unknown[] {
  const groups = hooks[event]
  if (groups === undefined) return []
  if (!Array.isArray(groups)) throw new Error(`settings.json hooks.${event} is not a list; fix it by hand first`)
  return groups
}

function hooksOf(settings: Settings): Readonly<Record<string, unknown>> {
  if (settings.hooks === undefined) return {}
  if (!isRecord(settings.hooks)) throw new Error('settings.json "hooks" is not an object; fix it by hand first')
  return settings.hooks
}

function entriesOf(group: unknown): readonly unknown[] {
  return isRecord(group) && Array.isArray(group.hooks) ? group.hooks : []
}

function samScripts(groups: readonly unknown[]): string[] {
  return groups.flatMap(entriesOf).map(samHookScript).filter((script): script is string => script !== null)
}

/** Drops our entries, and a group only when removing ours emptied it. */
function stripSam(groups: readonly unknown[]): unknown[] {
  return groups.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group]
    const others = group.hooks.filter((entry) => samHookScript(entry) === null)
    if (others.length === group.hooks.length) return [group]
    return others.length === 0 ? [] : [{ ...group, hooks: others }]
  })
}

function withHooks(settings: Settings, hooks: Readonly<Record<string, unknown>>): Settings {
  return { ...settings, hooks }
}

export function mergeSamHooks(settings: Settings, target: HookTarget): HooksMerge {
  let hooks = hooksOf(settings)
  const added: ClaudeHookEvent[] = []
  const replaced: ClaudeHookEvent[] = []
  for (const event of CLAUDE_HOOK_EVENTS) {
    const groups = groupsOf(hooks, event)
    const desired = JSON.stringify(samHookGroup(event, target))
    const scripts = samScripts(groups)
    if (scripts.length === 1 && groups.some((group) => JSON.stringify(group) === desired)) continue
    ;(scripts.length === 0 ? added : replaced).push(event)
    hooks = { ...hooks, [event]: [...stripSam(groups), samHookGroup(event, target)] }
  }
  const changed = added.length > 0 || replaced.length > 0
  return { settings: changed ? withHooks(settings, hooks) : settings, changed, added, replaced }
}

/** Removes only our entries; an event list or the hooks object goes only when we emptied it. */
export function removeSamHooks(settings: Settings): { settings: Settings; removed: number } {
  const hooks = hooksOf(settings)
  let next: Record<string, unknown> = { ...hooks }
  let removed = 0
  for (const event of Object.keys(hooks)) {
    const groups = groupsOf(hooks, event)
    const count = samScripts(groups).length
    if (count === 0) continue
    removed += count
    const stripped = stripSam(groups)
    const { [event]: _dropped, ...rest } = next
    next = stripped.length === 0 ? rest : { ...next, [event]: stripped }
  }
  if (removed === 0) return { settings, removed }
  if (Object.keys(next).length === 0) {
    const { hooks: _hooks, ...rest } = settings
    return { settings: rest, removed }
  }
  return { settings: withHooks(settings, next), removed }
}

/** Every hook.ts path our entries name, across all events. */
export function samScriptsIn(settings: Settings): string[] {
  const hooks = hooksOf(settings)
  return Object.keys(hooks).flatMap((event) => samScripts(groupsOf(hooks, event)))
}

/** yes: every event runs the current script; stale: some entry names another path; partial: some events missing. */
export function inspectSamHooks(settings: Settings, hookScript: string): WiringState {
  const hooks = hooksOf(settings)
  const all = samScriptsIn(settings)
  if (all.length === 0) return 'no'
  if (all.some((script) => script !== hookScript)) return 'stale'
  const wired = CLAUDE_HOOK_EVENTS.every((event) => samScripts(groupsOf(hooks, event)).includes(hookScript))
  return wired ? 'yes' : 'partial'
}
