// Crush hook payload -> NormalizedEvent. Built from Crush's hooks docs
// (github.com/charmbracelet/crush/blob/main/docs/hooks/README.md, checked
// 2026-11-13): Claude Code's field names (hook_event_name, session_id, cwd,
// tool_name, tool_input, tool_response as one string, error,
// last_assistant_message) under Crush's own event names. TurnStart carries
// only the common fields, no prompt text, so it is not recorded as a prompt.
// Interrupt and StopFailure end a turn as TurnEnd does.

import type { EventKind, NormalizedEvent } from '../contract/event'
import { normalizeClaudeStyle } from '../agents/families/claude-style-parse'
import type { AdapterContext } from './context'

export const CRUSH_HOST = 'crush'

/** The events Kinfold's `hook add` lines name, in crushrc order. */
export const CRUSH_EVENTS = ['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'TurnEnd', 'StopFailure', 'Interrupt', 'SessionEnd'] as const

const CRUSH_KINDS: Readonly<Record<string, EventKind>> = {
  SessionStart: 'session_start',
  PostToolUse: 'tool_result',
  PostToolUseFailure: 'tool_result',
  TurnEnd: 'turn_end',
  StopFailure: 'turn_end',
  Interrupt: 'turn_end',
  SessionEnd: 'session_end',
}

const parse = normalizeClaudeStyle(CRUSH_KINDS, CRUSH_HOST)

export function normalizeCrush(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  return parse(payload, context)
}
