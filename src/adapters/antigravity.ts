// Antigravity hook payload -> NormalizedEvent. Built from the Antigravity
// hooks docs (antigravity.google/docs/hooks.md, checked 2026-11-13); the
// App, CLI and IDE share them. Not Claude-shaped: camelCase fields, the
// conversation as conversationId, the workspace as workspacePaths (absolute
// directories; the first is the cwd), and the user's text as lastUserInput on
// every event rather than on a prompt event.
// The documented stdin carries no event name, so the event is read from the
// fields only it has. Install registers SessionStart, PreInvocation,
// PostToolUse and Stop only, which keeps that unambiguous: toolCall and
// stepIdx mean PostToolUse, invocationNum means PreInvocation, executionNum
// or terminationReason mean Stop. SessionStart is matched on its own shape:
// no lastUserInput, and only the fields the docs' SessionStart example shows.
// Anything else is no documented event and is not captured.
// Turns:
//   user_prompt: PreInvocation fires before every model call; invocationNum
//     0 is the first call of a run, so only that one is the user's turn.
//     Whether that count restarts each run is undocumented, so the profile
//     claims no per-prompt context until a live run shows it.
//   turn_end: Stop, which fires once when a run ends. PostInvocation fires
//     after every model call, so it would end one turn many times.
//   tool_result: PostToolUse documents toolCall { name, args } and an error
//     string, and no tool output, so the output is the error or empty.
// transcriptPath is documented as absolute but the docs' example starts with
// ~, so a path that is not absolute is left out.

import { isAbsolute } from 'node:path'
import { type EventKind, type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../contract/event'
import { type AdapterContext, AdapterInputError } from './context'

export const ANTIGRAVITY_HOST = 'antigravity'

/** The events install registers, in hooks.json order. */
export const ANTIGRAVITY_EVENTS = ['SessionStart', 'PreInvocation', 'PostToolUse', 'Stop'] as const

type Payload = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The fields of the docs' SessionStart example. */
const SESSION_START_FIELDS: ReadonlySet<string> = new Set(['conversationId', 'workspacePaths', 'transcriptPath', 'artifactDirectoryPath', 'modelName'])

const isSessionStart = (payload: Payload): boolean => payload.lastUserInput === undefined && Object.keys(payload).every((key) => SESSION_START_FIELDS.has(key))

/** The kind this payload becomes, or null for a model call after the first or a shape no documented event has. */
function kindOf(payload: Payload): EventKind | null {
  if (payload.toolCall !== undefined || payload.stepIdx !== undefined) return 'tool_result'
  if (payload.invocationNum !== undefined) return payload.invocationNum === 0 ? 'user_prompt' : null
  if (payload.executionNum !== undefined || payload.terminationReason !== undefined || payload.fullyIdle !== undefined) return 'turn_end'
  return isSessionStart(payload) ? 'session_start' : null
}

function workspaceOf(payload: Payload): string | undefined {
  const paths = payload.workspacePaths
  if (!Array.isArray(paths)) return undefined
  const first = paths[0]
  return typeof first === 'string' && isAbsolute(first) ? first : undefined
}

function toolOf(payload: Payload): ToolCall {
  const call = payload.toolCall
  const name = isRecord(call) ? str(call.name) : undefined
  if (!isRecord(call) || name === undefined || name === '') throw new AdapterInputError('tool event without toolCall.name')
  const error = str(payload.error) ?? ''
  return { name, input: call.args ?? {}, output: error, ...(error !== '' ? { isError: true } : {}) }
}

/** The strict mapping: throws AdapterInputError on a payload it cannot map; null for a later model call or a shape no documented event has. */
export function parseAntigravity(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  const sessionId = str(payload.conversationId)
  const cwd = workspaceOf(payload)
  if (sessionId === undefined || sessionId === '') throw new AdapterInputError('hook payload without conversationId')
  if (cwd === undefined) throw new AdapterInputError('hook payload without an absolute workspace path')
  const kind = kindOf(payload)
  if (kind === null) return null

  const transcript = str(payload.transcriptPath)
  const base: Omit<NormalizedEvent, 'kind'> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host: ANTIGRAVITY_HOST,
    hostSessionId: sessionId,
    occurredAt: context.now(),
    cwd,
    ...(context.hostVersion !== undefined ? { hostVersion: context.hostVersion } : {}),
    ...(transcript !== undefined && isAbsolute(transcript) ? { transcriptPath: transcript } : {}),
  }

  switch (kind) {
    case 'user_prompt':
      return { ...base, kind, promptText: str(payload.lastUserInput) ?? '', isUserTurn: true }
    case 'tool_result':
      return { ...base, kind, tool: toolOf(payload) }
    default:
      return { ...base, kind }
  }
}

/** A payload it cannot map is not captured, rather than an error, since the agent is built from docs. */
export function normalizeAntigravity(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  try {
    return parseAntigravity(payload, context)
  } catch (error: unknown) {
    if (error instanceof AdapterInputError) return null
    throw error
  }
}

/** Session-start context goes back as an injected system step, in the shape of the docs' SessionStart example. */
export function injectStepsOutput(text: string): string {
  return JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: text } }] })
}
