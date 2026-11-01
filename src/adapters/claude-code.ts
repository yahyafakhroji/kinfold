// Claude Code hook payload -> NormalizedEvent. Field names and shapes come from
// recorded payloads in test/fixtures/claude-code/, not from documentation.

import { isAbsolute } from 'node:path'
import { type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../contract/event'
import { type AdapterContext, AdapterInputError } from './context'

export const CLAUDE_CODE_HOST = 'claude-code'

const EXIT_CODE = /^Exit code (\d+)/
const SHELL_TOOLS = new Set(['Bash'])

type Payload = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Read returns { file: { content } }, Bash returns { stdout, stderr }; anything else is kept as JSON. */
export function flattenToolResponse(response: unknown): string {
  if (response === undefined || response === null) return ''
  if (typeof response === 'string') return response
  if (isRecord(response)) {
    if (isRecord(response.file) && typeof response.file.content === 'string') return response.file.content
    if (typeof response.stdout === 'string' || typeof response.stderr === 'string') {
      const stdout = str(response.stdout) ?? ''
      const stderr = str(response.stderr) ?? ''
      return stderr === '' ? stdout : `${stdout}\n[stderr]\n${stderr}`
    }
  }
  return JSON.stringify(response)
}

function toolName(payload: Payload): string {
  const name = str(payload.tool_name)
  if (name === undefined || name === '') throw new AdapterInputError('tool event without tool_name')
  return name
}

function succeededTool(payload: Payload): ToolCall {
  const name = toolName(payload)
  const response = payload.tool_response
  const interrupted = isRecord(response) && response.interrupted === true
  // A non-zero exit arrives as PostToolUseFailure instead, so a shell call that lands here exited 0.
  return {
    name,
    input: payload.tool_input ?? {},
    output: flattenToolResponse(response),
    ...(SHELL_TOOLS.has(name) && !interrupted ? { exitCode: 0 } : {}),
    ...(interrupted ? { isError: true } : {}),
  }
}

/** The only exit code a failure carries is inside its error text: "Exit code 1\n...". */
function failedTool(payload: Payload): ToolCall {
  const error = str(payload.error) ?? ''
  const exit = EXIT_CODE.exec(error)
  return {
    name: toolName(payload),
    input: payload.tool_input ?? {},
    output: error,
    isError: true,
    ...(exit ? { exitCode: Number(exit[1]) } : {}),
  }
}

/** Returns null for hook events P0 does not capture (SubagentStop, PreCompact, and the rest). */
export function normalizeClaudeCode(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  const sessionId = str(payload.session_id)
  const cwd = str(payload.cwd)
  if (sessionId === undefined || sessionId === '') throw new AdapterInputError('hook payload without session_id')
  if (cwd === undefined || !isAbsolute(cwd)) throw new AdapterInputError('hook payload without an absolute cwd')

  const promptId = str(payload.prompt_id)
  const transcriptPath = str(payload.transcript_path)
  const base: Omit<NormalizedEvent, 'kind'> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host: CLAUDE_CODE_HOST,
    hostSessionId: sessionId,
    occurredAt: context.now(),
    cwd,
    ...(context.hostVersion !== undefined ? { hostVersion: context.hostVersion } : {}),
    ...(promptId !== undefined ? { hostPromptId: promptId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  }

  switch (payload.hook_event_name) {
    case 'SessionStart':
      return { ...base, kind: 'session_start' }
    case 'UserPromptSubmit':
      // An empty prompt is still a real turn in Claude Code: an image-only submission.
      return { ...base, kind: 'user_prompt', promptText: str(payload.prompt) ?? '', isUserTurn: true }
    case 'PostToolUse':
      return { ...base, kind: 'tool_result', tool: succeededTool(payload) }
    case 'PostToolUseFailure':
      return { ...base, kind: 'tool_result', tool: failedTool(payload) }
    case 'Stop': {
      // Stop can fire several times per prompt; the daemon upserts the summary.
      const text = str(payload.last_assistant_message)
      return { ...base, kind: 'turn_end', ...(text !== undefined ? { assistantText: text } : {}) }
    }
    case 'SessionEnd':
      return { ...base, kind: 'session_end' }
    default:
      return null
  }
}

/**
 * The stdout line for a UserPromptSubmit hook that adds context to the turn:
 * Claude Code's documented hookSpecificOutput shape for that event. Used for
 * the prompt-time memory delta (P1-H).
 */
export function userPromptContextOutput(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })
}
