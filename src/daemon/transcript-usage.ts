// Turn usage for the opt-in impact test. At turn_end the daemon reads the
// agent's own transcript (Claude Code's JSONL, whose path every hook payload
// carries) for what the turn cost: tokens in and out, cache reads and writes,
// tool calls and how long it took. That is real usage reported by the API,
// which is what makes a held-out turn comparable with a normal one.
//
// The transcript holds the whole conversation, so this reads as little of it
// as the numbers need: the `usage` object, the type of each content block,
// timestamps, and the ids that tell one model call from the next. No message
// text is kept, returned or logged. Only the end of the file is read, since a
// turn is at its end; a turn whose prompt lies before that is not reported,
// because the assistant entries in view could be half of it. A missing,
// unreadable or malformed transcript yields null and nothing is recorded.

import { closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Database } from '../sqlite/types'

export const MAX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024

export interface TurnUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  toolCalls: number
  /** From the prompt to the last model entry; null when the transcript gives no usable times. */
  durationMs: number | null
}

/** A turn_end ingest saw, for an agent whose transcript can be read. */
export interface TurnEnd {
  sessionId: number
  promptNumber: number
  host: string
  projectKey: string
  transcriptPath: string
  occurredAt: number
}

type Entry = Record<string, unknown>

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A turn_end older than this is not read: by then the transcript's last turn may be a later one. */
export const MAX_TURN_END_AGE_MS = 60_000

/**
 * The turn ends worth reading. The transcript only says what its last turn
 * cost, so of a drain's turn ends (a backlog after a restart can hold many)
 * only the newest of each session can be matched to it, and only while fresh.
 * An older one would be given the latest turn's numbers under its own
 * held-out flag, which is exactly what the comparison must not contain.
 */
export function freshTurnEnds(turns: readonly TurnEnd[], now: number): TurnEnd[] {
  const newest = new Map<number, TurnEnd>()
  for (const turn of turns) {
    const seen = newest.get(turn.sessionId)
    if (seen === undefined || turn.occurredAt >= seen.occurredAt) newest.set(turn.sessionId, turn)
  }
  return [...newest.values()].filter((turn) => now - turn.occurredAt <= MAX_TURN_END_AGE_MS)
}

/** First read of the file's end; it grows from here only while the turn's prompt is not in view. */
const FIRST_TAIL_BYTES = 256 * 1024

/** The last `maxBytes` of the file as whole lines; null when it cannot be read. */
function tailLines(path: string, maxBytes: number): string[] | null {
  let fd: number | null = null
  try {
    // Checked before opening: opening a FIFO for reading blocks until something writes to it, which would hang the daemon.
    if (!lstatSync(path).isFile()) return null
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    if (!stat.isFile()) return null
    const length = Math.min(stat.size, maxBytes)
    const start = stat.size - length
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, start + read)
      if (got === 0) break
      read += got
    }
    const lines = buffer.subarray(0, read).toString('utf8').split('\n')
    // A read that starts mid-file starts mid-line: that first piece is dropped.
    return start > 0 ? lines.slice(1) : lines
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function parse(line: string): Entry | null {
  if (line.length < 2) return null
  try {
    const value: unknown = JSON.parse(line)
    return isRecord(value) ? value : null
  } catch {
    return null
  }
}

const mainThread = (entry: Entry): boolean => entry.isSidechain !== true

/** A prompt the user sent: a `user` entry that is not a tool result handed back to the model. */
function isPrompt(entry: Entry): boolean {
  if (entry.type !== 'user' || !mainThread(entry) || entry.isMeta === true || !isRecord(entry.message)) return false
  const content = entry.message.content
  if (typeof content === 'string') return true
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type !== 'tool_result')
}

function timeOf(entry: Entry): number | null {
  if (typeof entry.timestamp !== 'string') return null
  const time = Date.parse(entry.timestamp)
  return Number.isFinite(time) ? time : null
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0)

interface Call {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

/**
 * The usage of the turn that just ended, or null when it cannot be told.
 * `maxBytes` is how much of the file's end is read.
 */
export function readTurnUsage(path: string, maxBytes: number = MAX_TRANSCRIPT_TAIL_BYTES): TurnUsage | null {
  if (!isAbsolute(path) || !path.endsWith('.jsonl')) return null
  // A turn sits at the file's end and is usually small, so the read starts small and widens only until the turn's prompt is in view.
  let entries: Entry[] = []
  let promptAt = -1
  for (let bytes = Math.min(FIRST_TAIL_BYTES, maxBytes); ; bytes = Math.min(bytes * 4, maxBytes)) {
    const tail = tailLines(path, bytes)
    if (tail === null) return null
    entries = tail.map(parse).filter((entry): entry is Entry => entry !== null)
    promptAt = entries.length - 1
    while (promptAt >= 0 && !isPrompt(entries[promptAt]!)) promptAt -= 1
    if (promptAt !== -1 || bytes >= maxBytes) break
  }
  if (promptAt === -1) return null

  // Claude Code writes one entry per content block, each repeating its call's message id and usage.
  const calls = new Map<string, Call>()
  const tools = new Set<string>()
  let lastAt: number | null = null
  let unnamed = 0
  for (const entry of entries.slice(promptAt + 1)) {
    if (entry.type !== 'assistant' || !mainThread(entry) || !isRecord(entry.message)) continue
    const message = entry.message
    const used = isRecord(message.usage) ? message.usage : null
    if (used !== null) {
      const id = typeof message.id === 'string' && message.id !== '' ? message.id : `unnamed-${(unnamed += 1)}`
      const seen = calls.get(id)
      const now: Call = { input: count(used.input_tokens), output: count(used.output_tokens), cacheRead: count(used.cache_read_input_tokens), cacheCreation: count(used.cache_creation_input_tokens) }
      // A call logged while it streams repeats with a growing output count; its largest figures are the call's.
      calls.set(id, seen === undefined ? now : {
        input: Math.max(seen.input, now.input), output: Math.max(seen.output, now.output),
        cacheRead: Math.max(seen.cacheRead, now.cacheRead), cacheCreation: Math.max(seen.cacheCreation, now.cacheCreation),
      })
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block) && block.type === 'tool_use') tools.add(typeof block.id === 'string' ? block.id : `unnamed-${tools.size}`)
      }
    }
    lastAt = timeOf(entry) ?? lastAt
  }
  if (calls.size === 0) return null
  const startedAt = timeOf(entries[promptAt]!)
  const total = [...calls.values()].reduce((sum, call) => ({
    input: sum.input + call.input, output: sum.output + call.output, cacheRead: sum.cacheRead + call.cacheRead, cacheCreation: sum.cacheCreation + call.cacheCreation,
  }))
  return {
    inputTokens: total.input, outputTokens: total.output, cacheReadTokens: total.cacheRead, cacheCreationTokens: total.cacheCreation,
    toolCalls: tools.size,
    durationMs: startedAt !== null && lastAt !== null && lastAt >= startedAt ? lastAt - startedAt : null,
  }
}

/** Whether the impact test held recall back for this prompt: the row the holdout left says so. */
function wasHeldOut(db: Database, turn: TurnEnd): boolean {
  return db.query(
    `SELECT 1 FROM injections i JOIN sessions s ON s.host = i.host AND s.host_session_id = i.host_session_id
     WHERE s.id = $sessionId AND i.channel = 'prompt' AND i.prompt_number = $promptNumber AND i.held_out = 1 LIMIT 1`,
  ).get({ sessionId: turn.sessionId, promptNumber: turn.promptNumber }) !== null
}

/**
 * Reads each turn's usage and stores one row per turn; Stop firing again for
 * the same prompt replaces its row with the larger, later figures. Returns
 * how many were stored. Logs carry ids and counts, never a path or text.
 */
export function recordTurnUsage(db: Database, turns: readonly TurnEnd[], log: (line: string) => void): number {
  const write = db.query(
    `INSERT INTO turn_usage (session_id, prompt_number, host, project_key, held_out, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       tool_calls, duration_ms, occurred_at)
     VALUES ($sessionId, $promptNumber, $host, $projectKey, $heldOut, $inputTokens, $outputTokens, $cacheReadTokens, $cacheCreationTokens,
       $toolCalls, $durationMs, $occurredAt)
     ON CONFLICT (session_id, prompt_number) DO UPDATE SET
       held_out = excluded.held_out, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       cache_read_tokens = excluded.cache_read_tokens, cache_creation_tokens = excluded.cache_creation_tokens,
       tool_calls = excluded.tool_calls, duration_ms = excluded.duration_ms, occurred_at = excluded.occurred_at`,
  )
  let stored = 0
  for (const turn of turns) {
    const usage = readTurnUsage(turn.transcriptPath)
    if (usage === null) {
      log(`turn usage session=${turn.sessionId} prompt=${turn.promptNumber} not read`)
      continue
    }
    write.run({
      sessionId: turn.sessionId, promptNumber: turn.promptNumber, host: turn.host, projectKey: turn.projectKey, heldOut: wasHeldOut(db, turn) ? 1 : 0,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens,
      toolCalls: usage.toolCalls, durationMs: usage.durationMs, occurredAt: turn.occurredAt,
    })
    stored += 1
  }
  return stored
}
