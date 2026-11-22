// What `kinfold watch --debug` shows: why each recall came out as it did, held
// in the daemon's memory only. Nothing here is written to the store, and a
// restart starts it empty. The buffer is bounded by count and by bytes, so a
// busy day of prompts cannot grow the daemon. Events carry ids, titles,
// numbers and the redacted prompt's terms; never a transcript's text.

import { randomBytes } from 'node:crypto'
import type { TurnUsage } from '../../controllers/daemon/transcript-usage'

export const TRACE_MAX_EVENTS = 400
export const TRACE_MAX_BYTES = 1_048_576
/** A debug watcher polls once a second; this long after its last read it is gone. */
export const WATCHING_MS = 15_000

export type CandidateSource = 'keyword' | 'meaning' | 'keyword and meaning' | 'previous prompt'

/** sent; gated out (with the rule that refused it); in the gate but past the 200-token budget; or never weighed. */
export type CandidateOutcome = 'sent' | 'below cutoff' | 'over budget' | 'already delivered' | 'not current here'

export interface TraceCandidate {
  id: number
  title: string
  source: CandidateSource
  /** Cosine distance to the prompt; null for a keyword match no vector measured. */
  distance: number | null
  matchedTerms: number
  outcome: CandidateOutcome
  /** Why the gate refused it, in words: only for 'below cutoff'. */
  rule?: string
}

export interface SearchTrace {
  /** How the related lines were matched, as the block's header says. */
  mode: string
  /** What happened to the meaning half: ok, late, off, secret, busy, ... */
  semantic: string
  /** The embedding model the meaning half used; null when it did not answer. */
  space: string | null
  /** The redacted prompt's terms after stopwords. */
  terms: string[]
  /** The start of the redacted prompt the meaning half embedded; empty when none was embedded. */
  query: string
  candidates: TraceCandidate[]
}

export interface TracedRow {
  id: number
  title: string
}

interface TraceBase {
  at: number
  host: string
  /** The project's display name, and its key, so either filters. */
  project: string
  projectKey: string
  hostSessionId: string
}

export interface PromptTrace extends TraceBase {
  kind: 'prompt'
  hook: { ms: number; budgetMs: number; late: boolean; heldOut: boolean }
  /** New memory from other sessions: the delta. */
  fresh: TracedRow[]
  /** Null when no related search ran (held out, no prompt text, no project yet). */
  search: SearchTrace | null
  sent: { ids: number[]; tokens: number; line: string }
}

export interface StartTrace extends TraceBase {
  kind: 'start'
  rows: TracedRow[]
  tokens: number
}

export interface TurnTrace extends TraceBase {
  kind: 'turn'
  promptNumber: number
  /** Null when the transcript could not be read. */
  usage: TurnUsage | null
  /** What Kinfold added to this prompt, by its own estimate. */
  kinfoldTokens: number
}

export interface ObserverTrace extends TraceBase {
  kind: 'observer'
  /** succeeded, skipped, failed, blocked or disabled. */
  status: string
  events: number
  written: number
  /** For a failed run whose provider is backing off: the line status shows, naming what to fix. */
  note?: string
}

export type TraceInput = PromptTrace | StartTrace | TurnTrace | ObserverTrace
export type TraceEvent = TraceInput & { seq: number }

export interface TraceQuery {
  /** Null: start from now. */
  after: number | null
  host: string | null
  project: string | null
}

export interface TraceRead {
  cursor: number
  /** This buffer's id: a restarted daemon has a new one, and its cursor counts from 0 again. */
  epoch: string
  events: TraceEvent[]
}

export interface TraceBuffer {
  push(event: TraceInput): void
  /** Reading also marks a watcher as connected at `now`. */
  read(query: TraceQuery, now?: number): TraceRead

  /** Whether a debug watcher read in the last WATCHING_MS. */
  watching(now: number): boolean
}

export interface TraceLimits {
  maxEvents?: number
  maxBytes?: number
}

function matches(event: TraceEvent, query: TraceQuery): boolean {
  if (query.host !== null && event.host !== query.host) return false
  if (query.project === null) return true
  return event.projectKey === query.project || event.project.toLowerCase() === query.project.toLowerCase()
}

export function createTraceBuffer(limits: TraceLimits = {}): TraceBuffer {
  const maxEvents = limits.maxEvents ?? TRACE_MAX_EVENTS
  const maxBytes = limits.maxBytes ?? TRACE_MAX_BYTES
  let kept: { event: TraceEvent; bytes: number }[] = []
  let bytes = 0
  let seq = 0
  let lastRead: number | null = null
  const epoch = randomBytes(8).toString('hex')
  return {
    push: (input) => {
      seq += 1
      const event = { ...input, seq } as TraceEvent
      const size = JSON.stringify(event).length
      // One event larger than the whole buffer is dropped rather than emptying it.
      if (size > maxBytes) return
      kept = [...kept, { event, bytes: size }]
      bytes += size
      let drop = 0
      while (kept.length - drop > maxEvents || bytes > maxBytes) {
        bytes -= kept[drop]!.bytes
        drop += 1
      }
      if (drop > 0) kept = kept.slice(drop)
    },
    read: (query, now = Date.now()) => {
      lastRead = now
      if (query.after === null || query.after > seq) return { cursor: seq, epoch, events: [] }
      const after = query.after
      return { cursor: seq, epoch, events: kept.filter(({ event }) => event.seq > after && matches(event, query)).map(({ event }) => event) }
    },
    watching: (now) => lastRead !== null && now - lastRead <= WATCHING_MS,
  }
}
