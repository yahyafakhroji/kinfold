// Hook payloads in Gemini CLI's shape -> NormalizedEvent. Built from the
// Gemini CLI hooks reference (geminicli.com/docs/hooks/reference, checked
// 2026-11-13): snake_case common fields (session_id, transcript_path, cwd,
// hook_event_name, timestamp), the prompt on BeforeAgent, the reply as
// prompt_response on AfterAgent, and AfterTool's tool_name, tool_input and
// tool_response { llmContent, returnDisplay, error? }. The reference names
// those three properties without their types, so llmContent is read as text
// or as a list of { text } parts, and error as a string or { message }.
// Runtime path: imports only the contract and the adapter context.

import { isAbsolute } from 'node:path'
import { type EventKind, type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../../contract/event'
import { type AdapterContext, AdapterInputError } from '../../adapters/context'
import type { AgentId } from '../profile'

export type GeminiStyleEventMap = Readonly<Record<string, EventKind>>

type Payload = Record<string, unknown>

/** Gemini CLI's events and the kind each becomes; BeforeAgent carries the prompt, AfterAgent the reply. */
export const GEMINI_CLI_EVENTS: GeminiStyleEventMap = {
  SessionStart: 'session_start',
  BeforeAgent: 'user_prompt',
  AfterTool: 'tool_result',
  AfterAgent: 'turn_end',
  SessionEnd: 'session_end',
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function partsText(parts: readonly unknown[]): string {
  return parts.flatMap((part) => (isRecord(part) && typeof part.text === 'string' ? [part.text] : typeof part === 'string' ? [part] : [])).join('\n')
}

function contentText(response: Payload): string | undefined {
  const content = response.llmContent
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return partsText(content)
  if (isRecord(content) && typeof content.text === 'string') return content.text
  return str(response.returnDisplay)
}

function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error === '' ? undefined : error
  if (isRecord(error)) return str(error.message) ?? JSON.stringify(error)
  return undefined
}

function geminiTool(payload: Payload): ToolCall {
  const name = str(payload.tool_name)
  if (name === undefined || name === '') throw new AdapterInputError('tool event without tool_name')
  const response = payload.tool_response
  const base = { name, input: payload.tool_input ?? {} }
  if (!isRecord(response)) return { ...base, output: response === undefined || response === null ? '' : JSON.stringify(response) }
  const error = errorText(response.error)
  if (error !== undefined) return { ...base, output: error, isError: true }
  return { ...base, output: contentText(response) ?? JSON.stringify(response) }
}

/**
 * The strict mapping: throws AdapterInputError on a payload it cannot map, so
 * the hook logs why nothing was captured; null for events not in the table.
 */
export function parseGeminiStyle(eventMap: GeminiStyleEventMap, host: AgentId, payload: unknown, context: AdapterContext): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  const name = str(payload.hook_event_name) ?? ''
  const kind = Object.hasOwn(eventMap, name) ? eventMap[name] : undefined
  if (kind === undefined) return null
  const sessionId = str(payload.session_id)
  const cwd = str(payload.cwd)
  if (sessionId === undefined || sessionId === '') throw new AdapterInputError('hook payload without session_id')
  if (cwd === undefined || !isAbsolute(cwd)) throw new AdapterInputError('hook payload without an absolute cwd')

  const transcriptPath = str(payload.transcript_path)
  const base: Omit<NormalizedEvent, 'kind'> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host,
    hostSessionId: sessionId,
    occurredAt: context.now(),
    cwd,
    ...(context.hostVersion !== undefined ? { hostVersion: context.hostVersion } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  }

  switch (kind) {
    case 'user_prompt':
      return { ...base, kind, promptText: str(payload.prompt) ?? '', isUserTurn: true }
    case 'tool_result':
      return { ...base, kind, tool: geminiTool(payload) }
    case 'turn_end': {
      // AfterAgent can fire again after a hook asks for a retry; the daemon upserts the summary.
      const text = str(payload.prompt_response)
      return { ...base, kind, ...(text !== undefined ? { assistantText: text } : {}) }
    }
    default:
      return { ...base, kind }
  }
}

/**
 * The family's normalizer for an agent built from docs: a payload it cannot
 * map is not captured, rather than an error.
 */
export function normalizeGeminiStyle(eventMap: GeminiStyleEventMap, host: AgentId): (payload: unknown, ctx: AdapterContext) => NormalizedEvent | null {
  return (payload, ctx) => {
    try {
      return parseGeminiStyle(eventMap, host, payload, ctx)
    } catch (error: unknown) {
      if (error instanceof AdapterInputError) return null
      throw error
    }
  }
}
