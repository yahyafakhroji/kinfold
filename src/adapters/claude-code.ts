// Claude Code hook payload -> NormalizedEvent. Field names and shapes come from
// recorded payloads in test/fixtures/claude-code/, not from documentation.

import type { AdapterContext } from './context'
import type { NormalizedEvent } from '../contract/event'
import { type ClaudeStyleEventMap, flattenToolResponse, parseClaudeStyle } from '../agents/families/claude-style-parse'

export { flattenToolResponse }

export const CLAUDE_CODE_HOST = 'claude-code'

const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash'])

export const CLAUDE_CODE_EVENTS: ClaudeStyleEventMap = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt',
  PostToolUse: 'tool_result',
  PostToolUseFailure: 'tool_result',
  Stop: 'turn_end',
  SessionEnd: 'session_end',
}

/**
 * Returns null for hook events Kinfold does not capture (SubagentStop,
 * PreCompact, and the rest); throws AdapterInputError on a payload it cannot
 * map, which the hook logs, since Claude Code's recorded payloads always carry
 * session_id and cwd.
 */
export function normalizeClaudeCode(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  return parseClaudeStyle(CLAUDE_CODE_EVENTS, CLAUDE_CODE_HOST, payload, context, { shellTools: SHELL_TOOLS, flatten: flattenToolResponse, failureFromResult: false })
}

/**
 * The stdout line for a UserPromptSubmit hook that adds context to the turn:
 * Claude Code's documented hookSpecificOutput shape for that event. Used for
 * the prompt-time memory delta.
 */
export function userPromptContextOutput(text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text } })
}
