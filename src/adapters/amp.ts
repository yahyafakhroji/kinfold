// Amp event -> NormalizedEvent. Amp has no command hooks; its plugin API
// (ampcode.com/manual/plugin-api, checked 2026-11-13) calls a plugin's
// handlers in-process. Kinfold's plugin (agents/families/amp-plugin.ts) hands
// each event to `kinfold hook --host amp` as the documented event object plus
// two fields of its own: `event`, the event's name, and `cwd`, the workspace
// root Amp reports (system.workspaceRoot) or the plugin process's directory.
//   session.start { thread.id }                         -> session_start
//   agent.start   { thread.id, message, id }            -> user_prompt
//   tool.result   { thread.id, tool, input, status,
//                   error?, output? }                   -> tool_result
//   agent.end     { thread.id, message, id, status }    -> turn_end
// A cancelled tool call never ran, so it is not captured.

import { isAbsolute } from 'node:path'
import { type EventKind, type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../contract/event'
import { type AdapterContext, AdapterInputError } from './context'

export const AMP_HOST = 'amp'

const KINDS: Readonly<Record<string, EventKind>> = {
  'session.start': 'session_start',
  'agent.start': 'user_prompt',
  'tool.result': 'tool_result',
  'agent.end': 'turn_end',
}

type Payload = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const asText = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))

function toolOf(payload: Payload): ToolCall | null {
  const name = str(payload.tool)
  if (name === undefined || name === '') throw new AdapterInputError('tool.result without tool')
  if (payload.status === 'cancelled') return null
  const input = isRecord(payload.input) ? payload.input : {}
  if (payload.status === 'error') return { name, input, output: str(payload.error) ?? asText(payload.output), isError: true }
  return { name, input, output: asText(payload.output) }
}

/** The strict mapping: throws AdapterInputError on a payload it cannot map; null for an event not captured. */
export function parseAmp(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  const name = str(payload.event) ?? ''
  const kind = Object.hasOwn(KINDS, name) ? KINDS[name] : undefined
  if (kind === undefined) return null
  const thread = isRecord(payload.thread) ? str(payload.thread.id) : undefined
  const cwd = str(payload.cwd)
  if (thread === undefined || thread === '') throw new AdapterInputError('hook payload without thread.id')
  if (cwd === undefined || !isAbsolute(cwd)) throw new AdapterInputError('hook payload without an absolute cwd')

  const promptId = payload.id === undefined || payload.id === null ? undefined : String(payload.id)
  const base: Omit<NormalizedEvent, 'kind'> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host: AMP_HOST,
    hostSessionId: thread,
    occurredAt: context.now(),
    cwd,
    ...(context.hostVersion !== undefined ? { hostVersion: context.hostVersion } : {}),
    ...(promptId !== undefined && kind !== 'session_start' ? { hostPromptId: promptId } : {}),
  }
  switch (kind) {
    case 'user_prompt':
      return { ...base, kind, promptText: str(payload.message) ?? '', isUserTurn: true }
    case 'tool_result': {
      const tool = toolOf(payload)
      return tool === null ? null : { ...base, kind, tool }
    }
    default:
      return { ...base, kind }
  }
}

/** A payload it cannot map is not captured, rather than an error, since the agent is built from docs. */
export function normalizeAmp(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  try {
    return parseAmp(payload, context)
  } catch (error: unknown) {
    if (error instanceof AdapterInputError) return null
    throw error
  }
}

/** The AgentStartResult agent.start returns: a message appended after the user's text, not shown in the UI. */
export function ampMessageOutput(text: string): string {
  return JSON.stringify({ message: { content: text, display: false } })
}
