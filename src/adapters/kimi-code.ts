// Kimi Code CLI hook payload -> NormalizedEvent. Built from the Kimi Code
// hooks docs (kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html,
// checked 2026-11-13): snake_case stdin with hook_event_name, session_id and
// cwd on every event, Claude Code's event names, and Interrupt firing in
// place of Stop when the user stops a turn. The page lists the events but not
// every field: the prompt is read from `prompt` (the field it names on
// UserPromptQueued) and the tool output from tool_output or tool_response,
// whichever is there; a failure carries its error.

import type { EventKind, NormalizedEvent } from '../contract/event'
import { isRecord } from '../contract/event'
import { normalizeClaudeStyle } from '../agents/families/claude-style-parse'
import type { AdapterContext } from './context'

export const KIMI_CODE_HOST = 'kimi-code'

/** The events install registers, in config.toml order. */
export const KIMI_CODE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'Interrupt', 'SessionEnd'] as const

const KIMI_KINDS: Readonly<Record<string, EventKind>> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt',
  PostToolUse: 'tool_result',
  PostToolUseFailure: 'tool_result',
  Stop: 'turn_end',
  Interrupt: 'turn_end',
  SessionEnd: 'session_end',
}

const parse = normalizeClaudeStyle(KIMI_KINDS, KIMI_CODE_HOST)

export function normalizeKimiCode(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (isRecord(payload) && payload.tool_response === undefined && payload.tool_output !== undefined) {
    return parse({ ...payload, tool_response: payload.tool_output }, context)
  }
  return parse(payload, context)
}
