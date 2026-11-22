// The one shape every host adapter produces. The daemon accepts nothing else,
// so adding a host means writing an adapter, never touching the daemon.

import { isAbsolute } from 'node:path'
import { ULID_PATTERN } from './ulid'

export const SCHEMA_VERSION = 1

export const EVENT_KINDS = ['session_start', 'user_prompt', 'tool_result', 'turn_end', 'session_end'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** Hosts with an adapter in src/adapters/. Any other lowercase id still validates, so this list only grows. */
export const KNOWN_HOSTS = [
  'claude-code',
  'opencode',
  'codex',
  'cursor',
  'gemini-cli',
  'qwen-code',
  'factory-droid',
  'devin',
  'kilo-code',
  'cline',
  'copilot',
  'antigravity',
  'junie',
  'kiro',
  'amp',
  'kimi-code',
  'auggie',
  'goose',
  'crush',
  'zed',
  'continue',
  'warp',
] as const
export type KnownHost = (typeof KNOWN_HOSTS)[number]
export type HostId = KnownHost | (string & {})

export const WITHHELD_REASONS = ['sensitive_path', 'sensitive_command'] as const
export type WithheldReason = (typeof WITHHELD_REASONS)[number]

export interface ToolCall {
  name: string
  input: unknown
  /** Text the tool returned, as the adapter flattened it. */
  output: string
  exitCode?: number
  /** The host reported a failure: Claude Code's PostToolUseFailure, or a non-zero exit in OpenCode. */
  isError?: boolean
  /** Set when the capture CLI replaced the output with metadata only. */
  withheld?: WithheldReason
}

export interface RedactionNote {
  field: string
  rule: string
  count: number
}

export interface NormalizedEvent {
  schemaVersion: typeof SCHEMA_VERSION
  eventId: string
  host: HostId
  hostVersion?: string
  /** Unique only within its host; sessions key on (host, hostSessionId). */
  hostSessionId: string
  /** The host's id for the user prompt this event belongs to, when the host has one. */
  hostPromptId?: string
  kind: EventKind
  /** Epoch ms when it happened on the host, not when we ingested it. */
  occurredAt: number
  cwd: string
  promptText?: string
  /** Adapter's verdict: false for tool rounds and host helper prompts. */
  isUserTurn?: boolean
  tool?: ToolCall
  assistantText?: string
  transcriptPath?: string
  redactions?: readonly RedactionNote[]
}

export type ValidationResult =
  | { ok: true; event: NormalizedEvent }
  | { ok: false; errors: string[] }

const HOST_PATTERN = /^[a-z][a-z0-9-]{1,31}$/
const OPTIONAL_STRING_FIELDS = ['hostVersion', 'hostPromptId', 'promptText', 'assistantText', 'transcriptPath'] as const

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateTool(tool: unknown): string[] {
  if (!isRecord(tool)) return ['tool_result needs a tool object']
  const errors: string[] = []
  if (typeof tool.name !== 'string' || tool.name.trim() === '') errors.push('tool.name is required')
  if (typeof tool.output !== 'string') errors.push('tool.output must be a string')
  if (tool.exitCode !== undefined && !Number.isInteger(tool.exitCode)) errors.push('tool.exitCode must be an integer')
  if (tool.isError !== undefined && typeof tool.isError !== 'boolean') errors.push('tool.isError must be a boolean')
  if (tool.withheld !== undefined && !WITHHELD_REASONS.includes(tool.withheld as WithheldReason)) {
    errors.push(`tool.withheld must be one of ${WITHHELD_REASONS.join(', ')}`)
  }
  return errors
}

export function validateEvent(value: unknown): ValidationResult {
  if (!isRecord(value)) return { ok: false, errors: ['event must be an object'] }
  const errors: string[] = []

  if (value.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  if (typeof value.eventId !== 'string' || !ULID_PATTERN.test(value.eventId)) errors.push('eventId must be a ULID')
  if (typeof value.host !== 'string' || !HOST_PATTERN.test(value.host)) errors.push('host must be a lowercase id')
  if (typeof value.hostSessionId !== 'string' || value.hostSessionId.trim() === '') errors.push('hostSessionId is required')
  if (!EVENT_KINDS.includes(value.kind as EventKind)) errors.push(`kind must be one of ${EVENT_KINDS.join(', ')}`)
  if (!Number.isSafeInteger(value.occurredAt) || (value.occurredAt as number) <= 0) {
    errors.push('occurredAt must be epoch milliseconds')
  }
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) errors.push('cwd must be an absolute path')

  for (const key of OPTIONAL_STRING_FIELDS) {
    if (value[key] !== undefined && typeof value[key] !== 'string') errors.push(`${key} must be a string`)
  }
  if (value.isUserTurn !== undefined && typeof value.isUserTurn !== 'boolean') errors.push('isUserTurn must be a boolean')
  if (value.kind === 'user_prompt' && typeof value.promptText !== 'string') errors.push('user_prompt needs promptText')

  if (value.kind === 'tool_result') errors.push(...validateTool(value.tool))
  else if (value.tool !== undefined) errors.push('tool is only allowed on tool_result')

  return errors.length > 0 ? { ok: false, errors } : { ok: true, event: value as unknown as NormalizedEvent }
}
