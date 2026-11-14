// Augment Auggie CLI hook payload -> NormalizedEvent. Built from the Auggie
// hooks docs (docs.augmentcode.com/cli/hooks, checked 2026-11-13): every
// event carries hook_event_name, cwd, conversation_id and workspace_roots;
// PromptSubmit adds user_prompt; PostToolUse adds tool_name, tool_input,
// tool_output, tool_error and tool_is_error; Stop adds agent_stop_cause.
// The docs' own examples leave cwd out, so the first absolute workspace root
// stands in for it. The fields map onto Claude Code's names, so the
// Claude-style parser does the work.

import { isAbsolute } from 'node:path'
import type { EventKind, NormalizedEvent } from '../contract/event'
import { isRecord } from '../contract/event'
import { normalizeClaudeStyle } from '../agents/families/claude-style-parse'
import type { AdapterContext } from './context'

export const AUGGIE_HOST = 'auggie'

/** The events install registers, in settings.json order. */
export const AUGGIE_EVENTS = ['SessionStart', 'PromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'] as const

const AUGGIE_KINDS: Readonly<Record<string, EventKind>> = {
  SessionStart: 'session_start',
  PromptSubmit: 'user_prompt',
  PostToolUse: 'tool_result',
  Stop: 'turn_end',
  SessionEnd: 'session_end',
}

const parse = normalizeClaudeStyle(AUGGIE_KINDS, AUGGIE_HOST)

function cwdOf(payload: Readonly<Record<string, unknown>>): unknown {
  if (typeof payload.cwd === 'string') return payload.cwd
  const first = Array.isArray(payload.workspace_roots) ? payload.workspace_roots[0] : undefined
  return typeof first === 'string' && isAbsolute(first) ? first : undefined
}

/** A failed call goes in as an error, which the parser reads as a failed tool. */
function toolFields(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  if (payload.tool_is_error !== true) return { tool_response: payload.tool_output }
  const error = typeof payload.tool_error === 'string' && payload.tool_error !== '' ? payload.tool_error : payload.tool_output
  return { tool_response: undefined, error: typeof error === 'string' ? error : JSON.stringify(error ?? '') }
}

export function normalizeAuggie(payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) return null
  return parse({ ...payload, session_id: payload.conversation_id, cwd: cwdOf(payload), prompt: payload.user_prompt, ...toolFields(payload) }, context)
}
