// Hook payloads in Claude Code's shape -> NormalizedEvent, for every agent that
// copied it: snake_case fields (session_id, cwd, hook_event_name, tool_name,
// tool_input) and PascalCase event names. Each agent passes the table of the
// events it fires and the kind each one becomes. Runtime path: imports only
// the contract and the adapter context, never installer code.
// What differs between the agents, from their docs (2026-11-13):
//   tool output: tool_response (Claude Code, Qwen Code, Droid, Junie; Devin's
//     is { success, output, error }), or tool_result { result_type,
//     text_result_for_llm } (Copilot's PascalCase payloads);
//   a failed call: a PostToolUseFailure event with an `error` string, or a
//     result that says it did not succeed;
//   cwd: Junie documents project_path beside it and shows payloads without it.

import { isAbsolute } from 'node:path'
import { type EventKind, type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../../contract/event'
import { type AdapterContext, AdapterInputError } from '../../adapters/context'
import type { AgentId } from '../profile'

export type ClaudeStyleEventMap = Readonly<Record<string, EventKind>>

type Payload = Record<string, unknown>

export interface ClaudeStyleOptions {
  /** Tools whose successful result means exit code 0 (Claude Code's Bash); other agents' payloads carry no exit code. */
  shellTools?: ReadonlySet<string>
  /** Turns the tool output into text; Claude Code keeps its own, recorded-payload rules. */
  flatten?: (response: unknown) => string
  /** Whether a result's own success: false or result_type marks the call failed; Claude Code's recorded results carry neither. Default true. */
  failureFromResult?: boolean
}

const EXIT_CODE = /^Exit code (\d+)/

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

/** The other agents add `output` (Junie, Devin, with Devin's `error` beside it) and Copilot's text_result_for_llm. */
function flattenFamilyResponse(response: unknown): string {
  if (isRecord(response)) {
    if (typeof response.text_result_for_llm === 'string') return response.text_result_for_llm
    if (typeof response.output === 'string') {
      const error = str(response.error) ?? ''
      if (response.output === '') return error
      return error === '' ? response.output : `${response.output}\n[error]\n${error}`
    }
  }
  return flattenToolResponse(response)
}

function toolName(payload: Payload): string {
  const name = str(payload.tool_name)
  if (name === undefined || name === '') throw new AdapterInputError('tool event without tool_name')
  return name
}

/** Did the result itself say the call failed: Devin's success: false, or a Copilot result_type other than success. */
function resultFailed(response: unknown): boolean {
  if (!isRecord(response)) return false
  if (response.success === false) return true
  return typeof response.result_type === 'string' && response.result_type !== 'success'
}

function succeededTool(payload: Payload, options: ClaudeStyleOptions): ToolCall {
  const name = toolName(payload)
  const response = payload.tool_response !== undefined ? payload.tool_response : payload.tool_result
  const interrupted = isRecord(response) && response.interrupted === true
  const failed = interrupted || (options.failureFromResult !== false && resultFailed(response))
  // A non-zero exit arrives as PostToolUseFailure instead, so a shell call that lands here exited 0.
  return {
    name,
    input: payload.tool_input ?? {},
    output: (options.flatten ?? flattenFamilyResponse)(response),
    ...(options.shellTools?.has(name) === true && !failed ? { exitCode: 0 } : {}),
    ...(failed ? { isError: true } : {}),
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

/** PostToolUseFailure, in every agent that has it; a tool event carrying an error and no result reads the same. */
const isFailure = (name: string, payload: Payload): boolean =>
  name.endsWith('Failure') || (typeof payload.error === 'string' && payload.tool_response === undefined && payload.tool_result === undefined)

function cwdOf(payload: Payload): string | undefined {
  const cwd = str(payload.cwd)
  if (cwd !== undefined) return cwd
  const project = str(payload.project_path)
  return project !== undefined && isAbsolute(project) ? project : undefined
}

/**
 * The strict mapping: throws AdapterInputError on a payload it cannot map, so
 * the hook logs why nothing was captured; null for events not in the table.
 */
export function parseClaudeStyle(eventMap: ClaudeStyleEventMap, host: AgentId, payload: unknown, context: AdapterContext, options: ClaudeStyleOptions = {}): NormalizedEvent | null {
  if (!isRecord(payload)) throw new AdapterInputError('hook payload must be a JSON object')
  const name = str(payload.hook_event_name) ?? ''
  const kind = Object.hasOwn(eventMap, name) ? eventMap[name] : undefined
  if (kind === undefined) return null
  const sessionId = str(payload.session_id)
  const cwd = cwdOf(payload)
  if (sessionId === undefined || sessionId === '') throw new AdapterInputError('hook payload without session_id')
  if (cwd === undefined || !isAbsolute(cwd)) throw new AdapterInputError('hook payload without an absolute cwd')

  const promptId = str(payload.prompt_id)
  const transcriptPath = str(payload.transcript_path)
  const base: Omit<NormalizedEvent, 'kind'> = {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host,
    hostSessionId: sessionId,
    occurredAt: context.now(),
    cwd,
    ...(context.hostVersion !== undefined ? { hostVersion: context.hostVersion } : {}),
    ...(promptId !== undefined ? { hostPromptId: promptId } : {}),
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
  }

  switch (kind) {
    case 'user_prompt':
      // An empty prompt is still a real turn in Claude Code: an image-only submission.
      return { ...base, kind, promptText: str(payload.prompt) ?? '', isUserTurn: true }
    case 'tool_result':
      return { ...base, kind, tool: isFailure(name, payload) ? failedTool(payload) : succeededTool(payload, options) }
    case 'turn_end': {
      // Stop can fire several times per prompt; the daemon upserts the summary.
      const text = str(payload.last_assistant_message)
      return { ...base, kind, ...(text !== undefined ? { assistantText: text } : {}) }
    }
    default:
      return { ...base, kind }
  }
}

/**
 * The family's normalizer for an agent built from docs: a payload it cannot
 * map (no session_id, no absolute cwd, no tool_name) is not captured, rather
 * than an error, since the docs show some events without those fields.
 */
export function normalizeClaudeStyle(eventMap: ClaudeStyleEventMap, host: AgentId): (payload: unknown, ctx: AdapterContext) => NormalizedEvent | null {
  return (payload, ctx) => {
    try {
      return parseClaudeStyle(eventMap, host, payload, ctx)
    } catch (error: unknown) {
      if (error instanceof AdapterInputError) return null
      throw error
    }
  }
}
