// Kiro hook payload -> NormalizedEvent. Built from the Kiro docs, checked
// 2026-11-13:
//   kiro.dev/docs/hooks/ (command actions get session context as JSON on
//     stdin; triggers are PascalCase)
//   kiro.dev/docs/hooks/types/ (the stdin examples: hook_event_name, cwd,
//     session_id, tool_name, tool_input; the prompt is in the USER_PROMPT
//     environment variable; agentSpawn is the CLI 2.x spelling of
//     SessionStart)
//   kiro.dev/docs/cli/v3/hooks-migration/ (userPromptSubmit -> UserPromptSubmit,
//     stop -> Stop, agentSpawn -> SessionStart; SessionEnd is V3 only)
// The fields match Claude Code's, so the Claude-style parser does the work.
// The docs show no PostToolUse payload; tool_response is read when present,
// as in the other Claude-shaped agents, and the output is empty otherwise.

import type { EventKind, NormalizedEvent } from '../contract/event'
import { normalizeClaudeStyle } from '../agents/families/claude-style-parse'
import type { AdapterContext } from './context'

export const KIRO_HOST = 'kiro'

/** The triggers install registers, in kinfold.json order. */
export const KIRO_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'] as const

const KIRO_KINDS: Readonly<Record<string, EventKind>> = {
  SessionStart: 'session_start',
  AgentSpawn: 'session_start',
  agentSpawn: 'session_start',
  UserPromptSubmit: 'user_prompt',
  PostToolUse: 'tool_result',
  Stop: 'turn_end',
  SessionEnd: 'session_end',
}

const parse = normalizeClaudeStyle(KIRO_KINDS, KIRO_HOST)

/** The normalizer, with the USER_PROMPT reader injected: the hook passes its own environment. */
export function normalizeKiroWith(userPrompt: () => string | undefined): (payload: unknown, context: AdapterContext) => NormalizedEvent | null {
  return (payload, context) => {
    const event = parse(payload, context)
    if (event?.kind !== 'user_prompt' || event.promptText !== '') return event
    return { ...event, promptText: userPrompt() ?? '' }
  }
}
