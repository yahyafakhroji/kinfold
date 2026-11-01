// Codex CLI hook payload -> NormalizedEvent. Field names come from the Codex
// hooks docs (learn.chatgpt.com/docs/hooks, read 2026-10-25) and the input
// structs in openai/codex codex-rs/hooks/src/schema.rs, not from a live
// capture: Codex is not installed on the machine this was written on, so
// test/fixtures/codex/ is built from those documented shapes.
// Codex has no PostToolUseFailure: a shell call that exits non-zero still
// arrives as PostToolUse, and its tool_response is the model-facing text, so
// the exit code is read out of that text when it is there.

import { isAbsolute } from 'node:path'
import { type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../contract/event'
import { type AdapterContext, AdapterInputError } from './context'

export const CODEX_HOST = 'codex'

/** Unified exec ends with "Process exited with code N"; the older shell tool starts with "Exit code: N". */
const EXIT_PATTERNS = [/Process exited with code (-?\d+)/, /^Exit code:\s*(-?\d+)/m]

type Payload = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** MCP results are { content: [{ type: 'text', text }], isError }; shell and apply_patch are plain strings. */
export function flattenCodexResponse(response: unknown): string {
  if (response === undefined || response === null) return ''
  if (typeof response === 'string') return response
  if (isRecord(response) && Array.isArray(response.content)) {
    const text = response.content
      .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text !== '') return text
  }
  return JSON.stringify(response)
}

export function codexExitCode(output: string): number | undefined {
  for (const pattern of EXIT_PATTERNS) {
    const match = pattern.exec(output)
    if (match) return Number(match[1])
  }
  return undefined
}

function toolOf(payload: Payload): ToolCall {
  const name = str(payload.tool_name)
  if (name === undefined || name === '') throw new AdapterInputError('tool event without tool_name')
  const response = payload.tool_response
  const output = flattenCodexResponse(response)
  const exitCode = typeof response === 'string' ? codexExitCode(output) : undefined
  const failed = (exitCode !== undefined && exitCode !== 0) || (isRecord(response) && response.isError === true)
  return {
    name,
    input: payload.tool_input ?? {},
    output,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failed ? { isError: true } : {}),
  }
}

function baseEvent(payload: Payload, context: AdapterContext): Omit<NormalizedEvent, 'kind'> {
  const sessionId = str(payload.session_id)
  const cwd = str(payload.cwd)
  if (sessionId === undefined || sessionId === '') throw new AdapterInputError('hook payload without session_id')
  if (cwd === undefined || !isAbsolute(cwd)) throw new AdapterInputError('hook payload without an absolute cwd')
  const turnId = str(payload.turn_id)
  const transcriptPath = str(payload.transcript_path)
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host: CODEX_HOST,
    hostSessionId: sessionId,
    occurredAt: context.now(),
    cwd,
    ...(context.hostVersion !== undefined ? { hostVersion: context.hostVersion } : {}),
    ...(turnId !== undefined && turnId !== '' ? { hostPromptId: turnId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  }
}

/** Returns null for events not captured (PreToolUse, PermissionRequest, compaction, subagents, Interrupt). */
export function normalizeCodex(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  switch (payload.hook_event_name) {
    case 'SessionStart':
      return { ...baseEvent(payload, context), kind: 'session_start' }
    case 'UserPromptSubmit':
      return { ...baseEvent(payload, context), kind: 'user_prompt', promptText: str(payload.prompt) ?? '', isUserTurn: true }
    case 'PostToolUse':
      return { ...baseEvent(payload, context), kind: 'tool_result', tool: toolOf(payload) }
    case 'Stop': {
      const text = str(payload.last_assistant_message)
      return { ...baseEvent(payload, context), kind: 'turn_end', ...(text !== undefined ? { assistantText: text } : {}) }
    }
    case 'SessionEnd':
      return { ...baseEvent(payload, context), kind: 'session_end' }
    default:
      return null
  }
}
