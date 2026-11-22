// Our entries in Claude Code's settings.json: the claude shape of the shared
// JSON hooks writer (agents/families/json-hooks.ts). Our entry has the shape
// this project's .claude/settings.local.json proved live: one command and its
// args, timeout 10, async with matcher '*' for the tool events. The command is
// the checkout's bun on src/cli/hook.ts, or the installed program with
// --data-dir before `hook` (entry.ts), and carries no --host.

import {
  type HookTarget,
  type JsonHooksMerge,
  type JsonHooksSpec,
  type Settings,
  type WiringState,
  inspectJsonHooks,
  jsonHookItem,
  jsonHookScript,
  jsonHookScriptsIn,
  mergeJsonHooks,
  removeJsonHooks,
} from '../agents/families/json-hooks'
import type { EntryCommand } from './entry'

export type { HookTarget, Settings, WiringState }

export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionEnd'] as const
export type ClaudeHookEvent = (typeof CLAUDE_HOOK_EVENTS)[number]

export const HOOK_TIMEOUT_S = 10

export const CLAUDE_JSON_HOOKS: JsonHooksSpec = {
  shape: 'claude',
  events: CLAUDE_HOOK_EVENTS,
  hooksKey: 'hooks',
  timeoutS: HOOK_TIMEOUT_S,
  asyncEvents: ['PostToolUse', 'PostToolUseFailure'],
  label: 'settings.json',
}

export interface HooksMerge extends JsonHooksMerge {
  added: ClaudeHookEvent[]
  replaced: ClaudeHookEvent[]
}

export function samHookGroup(event: ClaudeHookEvent, target: HookTarget): Record<string, unknown> {
  return jsonHookItem(CLAUDE_JSON_HOOKS, event, target)
}

/** The hook.ts path or program path a Kinfold entry runs, or null when the entry is not ours. */
export function samHookScript(entry: unknown): string | null {
  return jsonHookScript(CLAUDE_JSON_HOOKS, entry)
}

export function mergeSamHooks(settings: Settings, target: HookTarget): HooksMerge {
  return mergeJsonHooks(CLAUDE_JSON_HOOKS, settings, target) as HooksMerge
}

/** Removes only our entries; an event list or the hooks object goes only when we emptied it. */
export function removeSamHooks(settings: Settings): { settings: Settings; removed: number } {
  return removeJsonHooks(CLAUDE_JSON_HOOKS, settings)
}

/** Every hook.ts path our entries name, across all events. */
export function samScriptsIn(settings: Settings): string[] {
  return jsonHookScriptsIn(CLAUDE_JSON_HOOKS, settings)
}

/**
 * yes: every event runs the expected entry; stale: some entry of ours runs
 * another script, program or data folder; partial: some events missing.
 */
export function inspectSamHooks(settings: Settings, expected: EntryCommand): WiringState {
  return inspectJsonHooks(CLAUDE_JSON_HOOKS, settings, expected)
}
