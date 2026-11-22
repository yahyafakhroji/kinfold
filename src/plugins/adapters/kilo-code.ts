// Kilo Code (the CLI, 7.x) hook payloads -> NormalizedEvent. Kilo runs
// OpenCode's 1.x plugin contract: a plugin's `server()` returns hooks, and the
// payloads differ from OpenCode 2.x's in every field this needs. Field names
// and shapes come from payloads recorded from Kilo CLI 7.8.27 in
// test/fixtures/kilo-code/:
//   event `session.created`       the session's id, directory, version and time
//   `chat.message`                the user's prompt: a message and its parts
//   `tool.execute.after`          a tool, its arguments and its text output
//   `experimental.text.complete`  each text part of the assistant's reply
//   event `session.idle`          the turn is over
// Kilo sends no event when a session is closed, so none ends here; the daemon
// ends a quiet session by its own idle rule.

import { isAbsolute } from 'node:path'
import { type NormalizedEvent, SCHEMA_VERSION, type ToolCall, isRecord } from '../../system/contract/event'
import { type AdapterContext, nonEmpty } from './context'
import { recent } from './recency'
import { resolveInputPaths } from './opencode'

export const KILO_HOST = 'kilo-code'

const MAX_TRACKED_SESSIONS = 256

export interface KiloContext extends AdapterContext {
  /** `directory` from the plugin's server input: where this Kilo was started. */
  directory: string
}

export interface KiloMapper {
  /** The `event` hook: session.created and session.idle; every other type maps to nothing. */
  event(event: unknown): NormalizedEvent[]
  /** The `chat.message` hook. A session this plugin never saw start is started first. */
  chatMessage(input: unknown, output: unknown): NormalizedEvent[]
  /** The `tool.execute.after` hook. */
  toolAfter(input: unknown, output: unknown): NormalizedEvent[]
  /** The `experimental.text.complete` hook: the reply's latest text part, kept for the turn's end. */
  textComplete(input: unknown, output: unknown): void
  /** Whether this session was seen to start or to take a prompt; Kilo's helper requests run under ids that never do. */
  knows(sessionId: string): boolean
  trackedSessions(): number
}

interface SessionState {
  directory?: string
  version?: string
  /** A prompt was sent and its turn has not ended. */
  inTurn: boolean
  reply?: string
}

function time(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined
}

/** The text the user typed: text parts in order, without the ones Kilo marks as its own. */
/** The text the person typed in a chat.message: its text parts, without the ones Kilo added itself. */
export function promptText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part): part is { text: string } => isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.synthetic !== true)
    .map((part) => part.text)
    .join('\n')
}

export function createKiloMapper(context: KiloContext): KiloMapper {
  // Insertion order is age, and a session in use is moved to the newest end: the one dropped when the map is full is the one idle longest.
  const sessions = new Map<string, SessionState>()

  const stateOf = (sessionId: string): { state: SessionState; isNew: boolean } => {
    const known = recent(sessions, sessionId)
    if (known !== undefined) return { state: known, isNew: false }
    if (sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
    const state: SessionState = { inTurn: false }
    sessions.set(sessionId, state)
    return { state, isNew: true }
  }

  const base = (sessionId: string, state: SessionState, occurredAt: number): Omit<NormalizedEvent, 'kind'> => {
    const version = state.version ?? context.hostVersion
    return {
      schemaVersion: SCHEMA_VERSION,
      eventId: context.newId(),
      host: KILO_HOST,
      hostSessionId: sessionId,
      occurredAt,
      cwd: state.directory ?? context.directory,
      ...(version !== undefined ? { hostVersion: version } : {}),
    }
  }

  /** The event, behind a session start when this is the first thing seen of its session. */
  const withStart = (sessionId: string, occurredAt: number, build: (state: SessionState) => NormalizedEvent | null): NormalizedEvent[] => {
    const { state, isNew } = stateOf(sessionId)
    const event = build(state)
    if (event === null) return []
    return isNew ? [{ ...base(sessionId, state, occurredAt), kind: 'session_start' }, event] : [event]
  }

  const created = (properties: Record<string, unknown>): NormalizedEvent[] => {
    const info = isRecord(properties.info) ? properties.info : {}
    const sessionId = nonEmpty(properties.sessionID) ?? nonEmpty(info.id)
    if (sessionId === undefined) return []
    const { state, isNew } = stateOf(sessionId)
    const directory = nonEmpty(info.directory)
    if (directory !== undefined && isAbsolute(directory)) state.directory = directory
    const version = nonEmpty(info.version)
    if (version !== undefined) state.version = version
    if (!isNew) return []
    return [{ ...base(sessionId, state, time(isRecord(info.time) ? info.time.created : undefined) ?? context.now()), kind: 'session_start' }]
  }

  const idle = (properties: Record<string, unknown>): NormalizedEvent[] => {
    const sessionId = nonEmpty(properties.sessionID)
    const state = sessionId === undefined ? undefined : sessions.get(sessionId)
    // Kilo also goes idle with no prompt behind it; only a prompt opens a turn to end.
    if (sessionId === undefined || state === undefined || !state.inTurn) return []
    const reply = state.reply
    state.inTurn = false
    delete state.reply
    return [{ ...base(sessionId, state, context.now()), kind: 'turn_end', ...(reply !== undefined ? { assistantText: reply } : {}) }]
  }

  return {
    event(event) {
      if (!isRecord(event) || !isRecord(event.properties)) return []
      if (event.type === 'session.created') return created(event.properties)
      if (event.type === 'session.idle') return idle(event.properties)
      return []
    },

    chatMessage(input, output) {
      if (!isRecord(input) || !isRecord(output)) return []
      const sessionId = nonEmpty(input.sessionID)
      const text = promptText(output.parts)
      if (sessionId === undefined || text.trim() === '') return []
      const message = isRecord(output.message) ? output.message : {}
      const occurredAt = time(isRecord(message.time) ? message.time.created : undefined) ?? context.now()
      const messageId = nonEmpty(message.id)
      return withStart(sessionId, occurredAt, (state) => {
        state.inTurn = true
        delete state.reply
        return {
          ...base(sessionId, state, occurredAt),
          kind: 'user_prompt',
          promptText: text,
          isUserTurn: true,
          ...(messageId !== undefined ? { hostPromptId: messageId } : {}),
        }
      })
    },

    toolAfter(input, output) {
      if (!isRecord(input)) return []
      const sessionId = nonEmpty(input.sessionID)
      const name = nonEmpty(input.tool)
      if (sessionId === undefined || name === undefined) return []
      const result = isRecord(output) ? output : {}
      const exit = isRecord(result.metadata) && Number.isInteger(result.metadata.exit) ? (result.metadata.exit as number) : undefined
      const occurredAt = context.now()
      return withStart(sessionId, occurredAt, (state) => {
        const tool: ToolCall = {
          name,
          input: resolveInputPaths(isRecord(input.args) ? input.args : {}, state.directory ?? context.directory),
          output: typeof result.output === 'string' ? result.output : '',
          ...(exit !== undefined ? { exitCode: exit } : {}),
          ...(exit !== undefined && exit !== 0 ? { isError: true } : {}),
        }
        return { ...base(sessionId, state, occurredAt), kind: 'tool_result', tool }
      })
    },

    textComplete(input, output) {
      const sessionId = isRecord(input) ? nonEmpty(input.sessionID) : undefined
      const text = isRecord(output) ? nonEmpty(output.text) : undefined
      const state = sessionId === undefined ? undefined : sessions.get(sessionId)
      if (state !== undefined && text !== undefined) state.reply = text
    },

    knows: (sessionId) => sessions.has(sessionId),
    trackedSessions: () => sessions.size,
  }
}
