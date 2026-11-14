// Goose hook payload -> NormalizedEvent. Built from Goose's hooks guide
// (goose-docs.ai/docs/guides/context-engineering/hooks/, checked 2026-11-13):
// every payload carries `event` and session_id; tool events add tool_name,
// tool_input and working_dir; UserPromptSubmit adds the prompt as `message`;
// Stop adds last_assistant_message. The guide documents a working folder on
// tool events only and no tool output, so an event without working_dir is not
// captured, and tool_output (the field Goose's HookContext serializes,
// github.com/aaif-goose/goose crates/goose/src/hooks/mod.rs) is read when
// present and is otherwise empty.

import type { EventKind, NormalizedEvent } from '../contract/event'
import { isRecord } from '../contract/event'
import { normalizeClaudeStyle } from '../agents/families/claude-style-parse'
import type { AdapterContext } from './context'

export const GOOSE_HOST = 'goose'

/**
 * The events install registers, in hooks.json order: the two documented with
 * working_dir. The others would spawn the hook on every prompt and turn end
 * and record nothing. GOOSE_KINDS still maps them, so a hooks.json written
 * before, or a Goose that does send a folder, is read rather than dropped.
 */
export const GOOSE_EVENTS = ['PostToolUse', 'PostToolUseFailure'] as const

const GOOSE_KINDS: Readonly<Record<string, EventKind>> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt',
  PostToolUse: 'tool_result',
  PostToolUseFailure: 'tool_result',
  Stop: 'turn_end',
  SessionEnd: 'session_end',
}

const parse = normalizeClaudeStyle(GOOSE_KINDS, GOOSE_HOST)

const asText = (value: unknown): string | undefined => (value === undefined || value === null ? undefined : typeof value === 'string' ? value : JSON.stringify(value))

export function normalizeGoose(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) return null
  const output = asText(payload.tool_output)
  return parse({
    ...payload,
    hook_event_name: payload.event,
    cwd: payload.working_dir,
    prompt: payload.message,
    ...(payload.event === 'PostToolUseFailure' ? { error: output ?? '' } : { tool_response: output }),
  }, context)
}
