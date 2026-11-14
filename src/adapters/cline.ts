// Cline hook payload -> NormalizedEvent. Built from Cline's hook docs and the
// payloads its two hosts build, checked 2026-11-13:
//   github.com/cline/cline/blob/main/.clinerules/hooks/README.md (the VS Code
//     extension: hookName TaskStart, UserPromptSubmit, PostToolUse,
//     TaskComplete, TaskCancel; taskId, workspaceRoots; per-hook blocks
//     taskStart, userPromptSubmit { prompt }, postToolUse { toolName,
//     parameters, result, success })
//   github.com/cline/cline/blob/main/sdk/examples/hooks/README.md (the CLI and
//     SDK: the same files fire as agent_start, prompt_submit, tool_result,
//     agent_end, agent_abort, session_shutdown, and a tool_result carries
//     tool_result { name, input, output, error })
// The CLI's tool_result also carries the VS Code postToolUse block
// (sdk/packages/core/src/hooks/hook-file-hooks.ts), so either block is read.
// Sessions key on taskId; the cwd is the first workspace root. A payload
// without either is not captured. TaskResume and PreToolUse are not
// registered, so they map to nothing.

import { isAbsolute } from 'node:path'
import { type EventKind, type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../contract/event'
import { type AdapterContext, AdapterInputError } from './context'

export const CLINE_HOST = 'cline'

/** The hook files install writes, named after the event as Cline requires, in write order. */
export const CLINE_HOOK_FILES = ['TaskStart', 'UserPromptSubmit', 'PostToolUse', 'TaskComplete', 'TaskCancel', 'SessionShutdown'] as const

/** Both hosts' hook names: the VS Code file name and the CLI's event name. */
const KINDS: Readonly<Record<string, EventKind>> = {
  TaskStart: 'session_start',
  agent_start: 'session_start',
  UserPromptSubmit: 'user_prompt',
  prompt_submit: 'user_prompt',
  PostToolUse: 'tool_result',
  tool_result: 'tool_result',
  TaskComplete: 'turn_end',
  agent_end: 'turn_end',
  TaskCancel: 'turn_end',
  agent_abort: 'turn_end',
  SessionShutdown: 'session_end',
  session_shutdown: 'session_end',
}

type Payload = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

const asText = (value: unknown): string => (value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value))

function workspaceOf(payload: Payload): string | undefined {
  const roots = payload.workspaceRoots
  const first = Array.isArray(roots) ? roots[0] : undefined
  return typeof first === 'string' && isAbsolute(first) ? first : undefined
}

/** The VS Code block (also sent by the CLI) first, then the CLI's own record. */
function toolOf(payload: Payload): ToolCall {
  const vscode = payload.postToolUse
  if (isRecord(vscode) && typeof vscode.toolName === 'string' && vscode.toolName !== '') {
    return { name: vscode.toolName, input: vscode.parameters ?? {}, output: asText(vscode.result), ...(vscode.success === false ? { isError: true } : {}) }
  }
  const cli = payload.tool_result
  if (isRecord(cli) && typeof cli.name === 'string' && cli.name !== '') {
    const error = str(cli.error) ?? ''
    return { name: cli.name, input: cli.input ?? {}, output: error !== '' ? error : asText(cli.output), ...(error !== '' ? { isError: true } : {}) }
  }
  throw new AdapterInputError('tool event without a tool name')
}

function promptOf(payload: Payload): string {
  const block = payload.userPromptSubmit
  return isRecord(block) ? (str(block.prompt) ?? '') : ''
}

/** The strict mapping: throws AdapterInputError on a payload it cannot map; null for a hook not registered. */
export function parseCline(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  const name = str(payload.hookName) ?? ''
  const kind = Object.hasOwn(KINDS, name) ? KINDS[name] : undefined
  if (kind === undefined) return null
  const sessionId = str(payload.taskId)
  const cwd = workspaceOf(payload)
  if (sessionId === undefined || sessionId === '') throw new AdapterInputError('hook payload without taskId')
  if (cwd === undefined) throw new AdapterInputError('hook payload without an absolute workspace root')

  const version = str(payload.clineVersion)
  const hostVersion = context.hostVersion ?? (version !== undefined && version !== '' ? version : undefined)
  const base: Omit<NormalizedEvent, 'kind'> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host: CLINE_HOST,
    hostSessionId: sessionId,
    occurredAt: context.now(),
    cwd,
    ...(hostVersion !== undefined ? { hostVersion } : {}),
  }
  switch (kind) {
    case 'user_prompt':
      return { ...base, kind, promptText: promptOf(payload), isUserTurn: true }
    case 'tool_result':
      return { ...base, kind, tool: toolOf(payload) }
    default:
      return { ...base, kind }
  }
}

/** A payload it cannot map is not captured, rather than an error, since the agent is built from docs. */
export function normalizeCline(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  try {
    return parseCline(payload, context)
  } catch (error: unknown) {
    if (error instanceof AdapterInputError) return null
    throw error
  }
}

/**
 * The output both hosts read: the VS Code extension validates cancel and
 * contextModification; the CLI reads contextModification when no `context`
 * is given.
 */
export function contextModificationOutput(text: string): string {
  return JSON.stringify({ cancel: false, contextModification: text })
}
