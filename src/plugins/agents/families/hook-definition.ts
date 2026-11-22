// Kinfold's hook definition in a config that keys hooks by a hook name first,
// { <name>: { Event: [...] } } (Antigravity's hooks.json,
// antigravity.google/docs/hooks.md, checked 2026-11-13). Tool events hold
// matcher groups { matcher, hooks: [handler] }; the other events hold handlers
// straight in the list; a handler is { type, command: "<shell>", timeout (s) }.
// The definition under our name is ours when one of its handlers runs our
// hook for this host (entry.ts), the way an MCP entry under our name is ours
// only when it runs our server: one under our name that runs anything else is
// left alone, on install and on uninstall. The user's `enabled` switch on ours
// survives a re-install.

import { isRecord } from '../../contract/event'
import type { InstallEnv } from '../../install/env'
import type { AgentId } from '../profile'
import type { JsonEdit, Settings } from './json-file'
import { type HookTarget, type JsonHooksSpec, type WiringState, hookTarget, jsonHookScript, shellCommand } from './json-hooks'
import { readPlainJsonObject } from './plain-json'

export const HOOK_DEFINITION_NAME = 'kinfold'

export interface HookDefinitionSpec {
  host: AgentId
  /** Every event we register, in the order written. */
  events: readonly string[]
  /** The tool events among them: their handler sits in a matcher group matching every tool. */
  toolEvents: readonly string[]
  timeoutS: number
}

type DefinitionState = 'no' | 'foreign' | 'yes' | 'stale'

function handler(spec: HookDefinitionSpec, target: HookTarget): Record<string, unknown> {
  return { type: 'command', command: shellCommand(target.entry), timeout: spec.timeoutS }
}

/** The definition an install writes. */
function desired(spec: HookDefinitionSpec, target: HookTarget): Record<string, unknown> {
  const entry = handler(spec, target)
  return Object.fromEntries(spec.events.map((event) => [event, spec.toolEvents.includes(event) ? [{ matcher: '*', hooks: [entry] }] : [entry]]))
}

/** Every handler in a definition, from both list forms. */
function handlersOf(definition: Readonly<Record<string, unknown>>): unknown[] {
  return Object.values(definition).flatMap((list) =>
    Array.isArray(list) ? list.flatMap((item) => (isRecord(item) && Array.isArray(item.hooks) ? item.hooks : [item])) : [],
  )
}

function isOurs(spec: HookDefinitionSpec, definition: unknown): definition is Readonly<Record<string, unknown>> {
  const owner: JsonHooksSpec = { shape: 'command', events: [], hooksKey: null, timeoutS: spec.timeoutS, host: spec.host }
  return isRecord(definition) && handlersOf(definition).some((entry) => jsonHookScript(owner, entry) !== null)
}

/** The definition without the user's own switch, for comparing with what an install writes. */
function withoutSwitch(definition: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { enabled: _enabled, ...rest } = definition
  return rest
}

function stateIn(spec: HookDefinitionSpec, settings: Settings, wanted: Record<string, unknown>): DefinitionState {
  if (!Object.hasOwn(settings, HOOK_DEFINITION_NAME)) return 'no'
  const definition = settings[HOOK_DEFINITION_NAME]
  if (!isOurs(spec, definition)) return 'foreign'
  return JSON.stringify(withoutSwitch(definition)) === JSON.stringify(wanted) ? 'yes' : 'stale'
}

/** Our definition added or refreshed; one under our name that is not ours is left alone. */
export function hookDefinitionEdit(spec: HookDefinitionSpec, target: HookTarget): JsonEdit {
  return (settings, path) => {
    const wanted = desired(spec, target)
    const state = stateIn(spec, settings, wanted)
    if (state === 'yes') return { settings, changed: false, note: `hooks already wired in ${path}` }
    if (state === 'foreign') return { settings, changed: false, note: `a hook named ${HOOK_DEFINITION_NAME} that is not ours is in ${path}; left alone` }
    const current = settings[HOOK_DEFINITION_NAME]
    const enabled = isRecord(current) && current.enabled !== undefined ? { enabled: current.enabled } : {}
    return {
      settings: { ...settings, [HOOK_DEFINITION_NAME]: { ...wanted, ...enabled } },
      changed: true,
      summary: `${state === 'stale' ? 'replace the' : 'add the'} Kinfold hook for ${spec.events.join(', ')} (${spec.host})`,
    }
  }
}

/** Only our definition out. */
export function hookDefinitionRemoveEdit(spec: HookDefinitionSpec): JsonEdit {
  return (settings) => {
    if (!isOurs(spec, settings[HOOK_DEFINITION_NAME])) return { settings, changed: false }
    const { [HOOK_DEFINITION_NAME]: _ours, ...rest } = settings
    return { settings: rest, changed: true, summary: 'remove the Kinfold hook' }
  }
}

/** The wiring state alone, read-only; 'unknown' when the file can't be read. */
export function hookDefinitionState(env: InstallEnv, path: string, spec: HookDefinitionSpec): WiringState | 'unknown' {
  try {
    const file = readPlainJsonObject(path)
    if (!file.exists) return 'no'
    const state = stateIn(spec, file.value, desired(spec, hookTarget(env, spec.host)))
    return state === 'foreign' ? 'no' : state
  } catch {
    return 'unknown'
  }
}
