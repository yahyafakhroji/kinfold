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
import { isRecord } from '../contract/event'

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

/** Reads bytes [start, end) of an open file; fewer when the file ends first. */
function readRange(fd: number, start: number, end: number): Buffer {
  const buffer = Buffer.alloc(end - start)
  let read = 0
  while (read < buffer.length) {
    const got = readSync(fd, buffer, read, buffer.length - read, start + read)
    if (got === 0) break
    read += got
  }
  return buffer.subarray(0, read)
}

const NEWLINE = 0x0a

/**
 * The turn at the file's end: its prompt entry and the entries after it, or
 * null when no prompt is within the last `maxBytes`. The file is read from its
 * end backward, a region at a time, and each region is read and parsed once:
 * lines are parsed from the newest back to the turn's prompt and no further.
 * A long turn used to re-read the whole tail at every widening step and parse
 * every line in it, about 13 MB of JSON for a prompt 8 MB back.
 */
function lastTurn(fd: number, size: number, maxBytes: number): { prompt: Entry; after: Entry[] } | null {
  /** Entries newer than the region being read, oldest first. */
  let after: Entry[] = []
  /** The start of the region already read: a line's tail whose head is in the region before it. Bytes, so a character cut by the boundary is whole again when joined. */
  let carry: Buffer = Buffer.alloc(0)
  let end = size
  for (let bytes = Math.min(FIRST_TAIL_BYTES, maxBytes); ; bytes = Math.min(bytes * 4, maxBytes)) {
    const start = Math.max(0, size - bytes)
    const region = Buffer.concat([readRange(fd, start, end), carry])
    // A region that starts mid-file starts mid-line: that first piece waits for the region before it.
    const firstBreak = start > 0 ? region.indexOf(NEWLINE) : -1
    carry = start > 0 ? region.subarray(0, firstBreak === -1 ? region.length : firstBreak) : Buffer.alloc(0)
    const lines = start > 0 ? (firstBreak === -1 ? [] : region.subarray(firstBreak + 1).toString('utf8').split('\n')) : region.toString('utf8').split('\n')
    const found: Entry[] = []
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const entry = parse(lines[index]!)
      if (entry === null) continue
      if (isPrompt(entry)) return { prompt: entry, after: [...found.reverse(), ...after] }
      found.push(entry)
    }
    after = [...found.reverse(), ...after]
    end = start
    if (start === 0 || bytes >= maxBytes) return null
  }
}

/** The turn at the end of the transcript; null when the file cannot be read or holds no prompt in reach. */
function readLastTurn(path: string, maxBytes: number): { prompt: Entry; after: Entry[] } | null {
  let fd: number | null = null
  try {
    // Checked before opening: opening a FIFO for reading blocks until something writes to it, which would hang the daemon.
    if (!lstatSync(path).isFile()) return null
    fd = openSync(path, 'r')
    const stat = fstatSync(fd)
    // The size is taken once: an agent appending to the file while it is read cannot shift the regions.
    return stat.isFile() ? lastTurn(fd, stat.size, maxBytes) : null
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
  const turn = readLastTurn(path, maxBytes)
  if (turn === null) return null

  // Claude Code writes one entry per content block, each repeating its call's message id and usage.
  const calls = new Map<string, Call>()
  const tools = new Set<string>()
  let lastAt: number | null = null
  let unnamed = 0
  for (const entry of turn.after) {
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
  const startedAt = timeOf(turn.prompt)
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

export interface TurnUsageOptions {
  /** false: read for `kinfold watch --debug` only, so no row is stored. Default true (the impact test). */
  store?: boolean
  /** Handed each turn's usage as read, null when the transcript gave none. */
  onRead?: (turn: TurnEnd, usage: TurnUsage | null) => void
}

/**
 * Reads each turn's usage and stores one row per turn; Stop firing again for
 * the same prompt replaces its row with the larger, later figures. Returns
 * how many were stored. Logs carry ids and counts, never a path or text.
 */
export function recordTurnUsage(db: Database, turns: readonly TurnEnd[], log: (line: string) => void, options: TurnUsageOptions = {}): number {
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
    try {
      options.onRead?.(turn, usage)
    } catch (error: unknown) {
      // The trace loses this turn; the impact test's rows must not.
      log(`turn usage trace failed: ${error instanceof Error ? error.name : 'error'}`)
    }
    if (options.store === false) continue
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
