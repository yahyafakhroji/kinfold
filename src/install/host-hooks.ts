// Our entries in Codex's ~/.codex/hooks.json and Cursor's ~/.cursor/hooks.json:
// the command shape of the shared JSON hooks writer
// (agents/families/json-hooks.ts). Both hosts take one shell command string,
// rendered from the command entry.ts builds with `--host <id>`, and an entry
// is ours only when it names that host. Shapes, from each host's docs (2026-10-25):
//   Codex:  { hooks: { Event: [ { matcher?, hooks: [ { type, command, timeout, async? } ] } ] } }
//   Cursor: { version: 1, hooks: { event: [ { command, timeout, matcher? } ] } }
// Codex has no wildcard matcher documented, so our groups carry none, which
// matches every tool. Codex caps SessionEnd hooks at 3 s.

import {
  type HookTarget,
  type JsonHooksMerge,
  type JsonHooksSpec,
  type Settings,
  type WiringState,
  inspectJsonHooks,
  jsonHookItem,
  jsonHookScript,
  mergeJsonHooks,
  removeJsonHooks,
  shellCommand,
} from '../agents/families/json-hooks'
import type { EntryCommand } from './entry'

export type CommandHookHost = 'codex' | 'cursor'

export interface CommandHookSpec extends JsonHooksSpec {
  host: CommandHookHost
  label: string
}

export const HOOK_TIMEOUT_S = 10
const CODEX_SESSION_END_TIMEOUT_S = 3

export const CODEX_HOOK_SPEC: CommandHookSpec = {
  shape: 'command',
  host: 'codex',
  label: 'Codex hooks.json',
  events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'],
  hooksKey: 'hooks',
  grouped: true,
  timeoutS: HOOK_TIMEOUT_S,
  timeoutsS: { SessionEnd: CODEX_SESSION_END_TIMEOUT_S },
  asyncEvents: ['PostToolUse'],
}

export const CURSOR_HOOK_SPEC: CommandHookSpec = {
  shape: 'command',
  host: 'cursor',
  label: 'Cursor hooks.json',
  events: ['sessionStart', 'beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'afterAgentResponse', 'stop', 'sessionEnd'],
  hooksKey: 'hooks',
  grouped: false,
  timeoutS: HOOK_TIMEOUT_S,
  version: 1,
}

export type HostHooksMerge = JsonHooksMerge

export function samCommand(target: HookTarget): string {
  return shellCommand(target.entry)
}

/** The hook.ts path or program path an entry of ours runs for `host`, or null when the entry is not ours. */
export function samCommandScript(entry: unknown, host: CommandHookHost): string | null {
  return jsonHookScript({ shape: 'command', events: [], hooksKey: 'hooks', timeoutS: HOOK_TIMEOUT_S, host }, entry)
}

export function samItem(spec: CommandHookSpec, event: string, target: HookTarget): Record<string, unknown> {
  return jsonHookItem(spec, event, target)
}

export function mergeHostHooks(spec: CommandHookSpec, settings: Settings, target: HookTarget): HostHooksMerge {
  return mergeJsonHooks(spec, settings, target)
}

/** Removes only our entries; an event list goes only when we emptied it. The hooks object itself stays. */
export function removeHostHooks(spec: CommandHookSpec, settings: Settings): { settings: Settings; removed: number } {
  const result = removeJsonHooks(spec, settings)
  if (result.removed === 0 || result.settings.hooks !== undefined) return result
  return { settings: { ...settings, hooks: {} }, removed: result.removed }
}

/**
 * yes: every event runs the expected entry; stale: some entry of ours runs
 * another script, program or data folder; partial: some events missing.
 */
export function inspectHostHooks(spec: CommandHookSpec, settings: Settings, expected: EntryCommand): WiringState {
  return inspectJsonHooks(spec, settings, expected)
}
