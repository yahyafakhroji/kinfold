// OpenCode 2.x (V2 plugin contract) events -> NormalizedEvent. Field names and
// shapes come from recorded OpenCode 2.1.4 events in test/fixtures/opencode/.

import { isAbsolute, resolve } from 'node:path'
import { type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../contract/event'
import { type AdapterContext, AdapterInputError } from './context'

export const OPENCODE_HOST = 'opencode'

export interface OpenCodeContext extends AdapterContext {
  /** `ctx.location.directory` from the plugin's setup: the checkout this OpenCode serves. */
  directory: string
  /**
   * OpenCode version per session, learned from session.created's data.version
   * by the bus mapper and shared with the hook handlers of the same plugin
   * instance; it wins over the installer's record in `hostVersion`.
   */
  sessionVersions?: Map<string, string>
}

const PATH_KEYS: ReadonlySet<string> = new Set(['path', 'filePath'])
const MAX_TRACKED_SESSIONS = 256

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function requireDirectory(context: OpenCodeContext): void {
  if (!isAbsolute(context.directory)) throw new AdapterInputError('OpenCode context without an absolute directory')
}

function baseEvent(sessionId: string, context: OpenCodeContext, occurredAt: number, cwd: string): Omit<NormalizedEvent, 'kind'> {
  const version = context.sessionVersions?.get(sessionId) ?? context.hostVersion
  return {
    schemaVersion: SCHEMA_VERSION,
    eventId: context.newId(),
    host: OPENCODE_HOST,
    hostSessionId: sessionId,
    occurredAt,
    cwd,
    ...(version !== undefined ? { hostVersion: version } : {}),
  }
}

function rememberVersion(context: OpenCodeContext, sessionId: string, data: Record<string, unknown>): void {
  const versions = context.sessionVersions
  const version = str(data.version)
  if (versions === undefined || version === undefined || version === '') return
  versions.delete(sessionId)
  if (versions.size >= MAX_TRACKED_SESSIONS) {
    const oldest = versions.keys().next().value
    if (oldest !== undefined) versions.delete(oldest)
  }
  versions.set(sessionId, version)
}

/** OpenCode tool paths are relative to the checkout; stored paths and .memignore rules need them absolute. */
export function resolveInputPaths(input: Record<string, unknown>, directory: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) =>
      [key, PATH_KEYS.has(key) && typeof value === 'string' && !isAbsolute(value) ? resolve(directory, value) : value]),
  )
}

/** Text blocks in `result.content` are the reliable source; `result.output` varies by tool. */
export function extractResultText(result: unknown): string {
  if (typeof result === 'string') return result
  if (!isRecord(result)) return ''
  if (typeof result.content === 'string') return result.content
  if (Array.isArray(result.content)) {
    const text = result.content
      .filter((block): block is { type: 'text'; text: string } => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text !== '') return text
  }
  if (typeof result.output === 'string') return result.output
  if (isRecord(result.output) && typeof result.output.output === 'string') return result.output.output
  return ''
}

function exitOf(result: unknown): number | undefined {
  if (!isRecord(result)) return undefined
  for (const holder of [result.output, result.metadata]) {
    if (isRecord(holder) && Number.isInteger(holder.exit)) return holder.exit as number
  }
  return undefined
}

function errorText(error: unknown): string | undefined {
  if (typeof error === 'string') return error
  return isRecord(error) ? str(error.message) : undefined
}

/** `ctx.tool.hook("execute.after")`. A failed shell call still reports status "completed", so the exit code decides. */
export function normalizeOpenCodeToolAfter(event: unknown, context: OpenCodeContext): NormalizedEvent {
  requireDirectory(context)
  if (!isRecord(event)) throw new AdapterInputError('tool event must be an object')
  const sessionId = str(event.sessionID)
  const name = str(event.tool)
  if (sessionId === undefined || name === undefined) throw new AdapterInputError('tool event without sessionID or tool')

  const rawInput = isRecord(event.input) ? event.input : isRecord(event.args) ? event.args : {}
  const exitCode = exitOf(event.result)
  const error = errorText(event.error)
  const failed = (event.status !== undefined && event.status !== 'completed') || error !== undefined || (exitCode !== undefined && exitCode !== 0)
  const text = extractResultText(event.result)

  const tool: ToolCall = {
    name,
    input: resolveInputPaths(rawInput, context.directory),
    output: text === '' && error !== undefined ? error : text,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(failed ? { isError: true } : {}),
  }
  return { ...baseEvent(sessionId, context, context.now(), context.directory), kind: 'tool_result', tool }
}

/** `ctx.session.hook("prompt")`. Returns null for a prompt with no text. */
export function normalizeOpenCodePrompt(event: unknown, context: OpenCodeContext): NormalizedEvent | null {
  requireDirectory(context)
  if (!isRecord(event)) throw new AdapterInputError('prompt event must be an object')
  const sessionId = str(event.sessionID)
  if (sessionId === undefined) throw new AdapterInputError('prompt event without sessionID')
  const text = isRecord(event.prompt) ? str(event.prompt.text) : undefined
  if (text === undefined || text.trim() === '') return null

  const messageId = str(event.messageID)
  return {
    ...baseEvent(sessionId, context, context.now(), context.directory),
    kind: 'user_prompt',
    promptText: text,
    isUserTurn: true,
    ...(messageId !== undefined ? { hostPromptId: messageId } : {}),
  }
}

export type OpenCodeBusMapper = (envelope: unknown) => NormalizedEvent | null

/**
 * Maps `ctx.event.subscribe()` envelopes. Stateful: the assistant reply arrives
 * in `session.text.ended`, and the turn ends later with `session.execution.succeeded`.
 */
export function createOpenCodeBusMapper(context: OpenCodeContext): OpenCodeBusMapper {
  requireDirectory(context)
  const replies = new Map<string, string>()
  // `opencode run` delivers one session.created up to three times (seen live:
  // same session, same bus time); a session starts once.
  const started = new Set<string>()
  const directories = new Map<string, string>()

  const rememberDirectory = (sessionId: string, directory: string): void => {
    directories.delete(sessionId)
    if (directories.size >= MAX_TRACKED_SESSIONS) {
      const oldest = directories.keys().next().value
      if (oldest !== undefined) directories.delete(oldest)
    }
    directories.set(sessionId, directory)
  }

  const markStarted = (sessionId: string): boolean => {
    if (started.has(sessionId)) return false
    if (started.size >= MAX_TRACKED_SESSIONS) {
      const oldest = started.values().next().value
      if (oldest !== undefined) started.delete(oldest)
    }
    started.add(sessionId)
    return true
  }

  const remember = (sessionId: string, text: string): void => {
    replies.delete(sessionId)
    if (replies.size >= MAX_TRACKED_SESSIONS) {
      const oldest = replies.keys().next().value
      if (oldest !== undefined) replies.delete(oldest)
    }
    replies.set(sessionId, text)
  }

  return (envelope) => {
    if (!isRecord(envelope) || !isRecord(envelope.data)) return null
    const sessionId = str(envelope.data.sessionID)
    if (sessionId === undefined) return null

    const created = envelope.created
    const occurredAt = Number.isSafeInteger(created) && (created as number) > 0 ? (created as number) : context.now()
    const where = isRecord(envelope.location) ? str(envelope.location.directory) : undefined
    if (where !== undefined && isAbsolute(where)) rememberDirectory(sessionId, where)
    // session.execution.succeeded has no location; it happened where the session's located envelopes did.
    const cwd = where !== undefined && isAbsolute(where) ? where : (directories.get(sessionId) ?? context.directory)
    const base = (): Omit<NormalizedEvent, 'kind'> => baseEvent(sessionId, context, occurredAt, cwd)

    switch (envelope.type) {
      case 'session.created':
        rememberVersion(context, sessionId, envelope.data)
        return markStarted(sessionId) ? { ...base(), kind: 'session_start' } : null
      case 'session.text.ended': {
        const text = str(envelope.data.text)
        if (text !== undefined) remember(sessionId, text)
        return null
      }
      case 'session.execution.succeeded': {
        const text = replies.get(sessionId)
        replies.delete(sessionId)
        return { ...base(), kind: 'turn_end', ...(text !== undefined ? { assistantText: text } : {}) }
      }
      case 'session.deleted':
        replies.delete(sessionId)
        return { ...base(), kind: 'session_end' }
      default:
        return null
    }
  }
}
