// Cursor agent hook payload -> NormalizedEvent. Field names come from the
// Cursor hooks docs (cursor.com/docs/agent/hooks, read 2026-10-25, rechecked
// 2026-10-26). Cursor is not installed here; the fields read below were checked
// against public captures from real runs (IDE 3.12.17 and 3.17.8, CLI
// 2026.10.19), which agree with the docs and add: cwd is absent on non-shell
// tools and "" on the CLI shell, transcript_path can be null, session_id equals
// conversation_id, and Read's tool_output is {file_path, content_length}.
// Every Cursor payload carries conversation_id (stable across turns),
// generation_id (one per user message) and cursor_version, so this is the one
// host whose events name their own version. Only the tool events carry a cwd;
// the rest fall back to the first workspace root.
// Turns: afterAgentResponse holds the reply text and ends a completed turn;
// stop ends a turn only when it was aborted or errored, because a completed
// turn already ended with its reply and a second turn_end would add nothing.

import { isAbsolute } from 'node:path'
import { type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../contract/event'
import { type AdapterContext, AdapterInputError } from './context'

export const CURSOR_HOST = 'cursor'

type Payload = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function nonEmpty(value: unknown): string | undefined {
  const text = str(value)
  return text === undefined || text === '' ? undefined : text
}

/** tool_output is documented as a JSON-stringified string; the shape inside is not, so text fields are tried in turn. */
export function flattenCursorOutput(raw: unknown): { output: string; exitCode?: number } {
  if (typeof raw !== 'string') return { output: raw === undefined || raw === null ? '' : JSON.stringify(raw) }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { output: raw }
  }
  if (typeof parsed === 'string') return { output: parsed }
  if (!isRecord(parsed)) return { output: raw }
  const exit = [parsed.exitCode, parsed.exit_code].find((value) => Number.isInteger(value)) as number | undefined
  const text = [parsed.output, parsed.stdout, parsed.content, parsed.result].find((value) => typeof value === 'string') as string | undefined
  return { output: text ?? raw, ...(exit !== undefined ? { exitCode: exit } : {}) }
}

function toolName(payload: Payload): string {
  const name = nonEmpty(payload.tool_name)
  if (name === undefined) throw new AdapterInputError('tool event without tool_name')
  return name
}

function succeededTool(payload: Payload): ToolCall {
  const { output, exitCode } = flattenCursorOutput(payload.tool_output)
  return {
    name: toolName(payload),
    input: payload.tool_input ?? {},
    output,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(exitCode !== undefined && exitCode !== 0 ? { isError: true } : {}),
  }
}

function failedTool(payload: Payload): ToolCall {
  const reason = str(payload.failure_type)
  const message = str(payload.error_message) ?? ''
  return { name: toolName(payload), input: payload.tool_input ?? {}, output: reason !== undefined && message === '' ? reason : message, isError: true }
}

function cwdOf(payload: Payload): string {
  const own = str(payload.cwd)
  if (own !== undefined && isAbsolute(own)) return own
  const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : []
  const root = roots.find((entry): entry is string => typeof entry === 'string' && isAbsolute(entry))
  if (root === undefined) throw new AdapterInputError('hook payload without an absolute cwd or workspace root')
  return root
}

function baseEvent(payload: Payload, context: AdapterContext): Omit<NormalizedEvent, 'kind'> {
  const sessionId = nonEmpty(payload.conversation_id) ?? nonEmpty(payload.session_id)
  if (sessionId === undefined) throw new AdapterInputError('hook payload without conversation_id')
  const version = nonEmpty(payload.cursor_version) ?? context.hostVersion
  const generationId = nonEmpty(payload.generation_id)
  const transcriptPath = nonEmpty(payload.transcript_path)
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host: CURSOR_HOST,
    hostSessionId: sessionId,
    occurredAt: context.now(),
    cwd: cwdOf(payload),
    ...(version !== undefined ? { hostVersion: version } : {}),
    ...(generationId !== undefined ? { hostPromptId: generationId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  }
}

/** Returns null for events not captured (pre-* gates, file and shell after-hooks, subagents, tab and app hooks). */
export function normalizeCursor(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  switch (payload.hook_event_name) {
    case 'sessionStart':
      return { ...baseEvent(payload, context), kind: 'session_start' }
    case 'beforeSubmitPrompt':
      return { ...baseEvent(payload, context), kind: 'user_prompt', promptText: str(payload.prompt) ?? '', isUserTurn: true }
    case 'postToolUse':
      return { ...baseEvent(payload, context), kind: 'tool_result', tool: succeededTool(payload) }
    case 'postToolUseFailure':
      return { ...baseEvent(payload, context), kind: 'tool_result', tool: failedTool(payload) }
    case 'afterAgentResponse': {
      const text = str(payload.text)
      return { ...baseEvent(payload, context), kind: 'turn_end', ...(text !== undefined ? { assistantText: text } : {}) }
    }
    case 'stop':
      return payload.status === 'completed' ? null : { ...baseEvent(payload, context), kind: 'turn_end' }
    case 'sessionEnd':
      return { ...baseEvent(payload, context), kind: 'session_end' }
    default:
      return null
  }
}
