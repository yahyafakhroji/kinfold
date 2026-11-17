// Spool -> SQLite. One transaction per batch, and spool files are removed only
// after it commits: a crash or a failed insert leaves the files for the next
// drain, and event_id makes the retry a no-op for rows that did land.
// No observer work here: rows wait with observer_state 'pending'.

import { createHash } from 'node:crypto'
import { DEFAULT_MAX_FIELD_CHARS, type PrepareOptions, type RedactedEvent, prepareForSpool } from '../capture/prepare'
import type { NormalizedEvent } from '../contract/event'
import { type QuarantinedEntry, type SpoolEntry, type SpoolRead, readSpool, removeSpoolEntry } from '../spool/spool'
import type { Database } from '../sqlite/types'
import { HOLDOUT_HOSTS } from '../context/holdout'
import { stampInjectionPrompts } from '../store/context-store'
import type { TurnEnd } from './transcript-usage'
import type { ProjectKey, ProjectKeyResolver } from '../store/project-key'
import {
  eventExists,
  insertEvent,
  insertPrompt,
  latestPromptNumber,
  markSessionEnded,
  promptNumberForHostId,
  setPromptReply,
  LOCAL_DEVICE,
  upsertSession,
} from '../store/writes'
import { registerProject } from '../store/project-merge'

export interface DrainOptions extends PrepareOptions {
  spoolDir: string
  projectKeyFor: ProjectKeyResolver
  batchSize?: number
  now?: () => number
  /** sessions.device for what this drain stores; LOCAL_DEVICE when absent. */
  device?: string | null
}

export interface DrainResult {
  read: number
  inserted: number
  duplicates: number
  removed: number
  quarantined: QuarantinedEntry[]
  /**
   * The turn_end events this drain stored for an agent whose transcript holds
   * the turn's usage, each with the transcript's path: the daemon reads them
   * after the commit, while the impact test is on.
   */
  turnEnds: TurnEnd[]
  /** Set when a batch failed to commit; its spool files are still in place. */
  error?: string
}

export const DEFAULT_BATCH_SIZE = 200

/** The edge already capped fields; the slack lets a capped field plus its truncation marker through untouched. */
const SECOND_PASS_SLACK = 256
const WITHHELD_MARKER = /^<withheld reason="[a-z_]+" lines="\d+" chars="\d+"\/>$/

/**
 * The daemon's redaction pass, in case the rules changed since
 * capture. Redaction markers survive a re-run unchanged; the withheld marker
 * would not (it would describe itself), so an intact one is kept, and the
 * edge's redaction notes are kept alongside any new ones.
 */
export function secondPass(event: NormalizedEvent, options: PrepareOptions): RedactedEvent {
  const maxFieldChars = (options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS) + SECOND_PASS_SLACK
  const again = prepareForSpool(event, { ...options, maxFieldChars })
  const original = event.tool
  const keepMarker = original?.withheld !== undefined && WITHHELD_MARKER.test(original.output)
  const freshNotes = (again.redactions ?? []).filter(
    (note) => !(keepMarker && note.field === 'tool.output' && note.rule === original?.withheld),
  )
  return {
    ...again,
    ...(keepMarker && again.tool !== undefined ? { tool: { ...again.tool, output: original!.output } } : {}),
    redactions: [...(event.redactions ?? []), ...freshNotes],
  } as RedactedEvent
}

/** sha256 over the redacted text an observer would read, so repeats can skip an observer call. */
export function contentHash(event: NormalizedEvent): string {
  const hash = createHash('sha256')
  const parts = [
    event.kind,
    event.tool?.name ?? '',
    event.tool !== undefined ? JSON.stringify(event.tool.input ?? null) : '',
    event.tool?.output ?? '',
    event.promptText ?? '',
    event.assistantText ?? '',
  ]
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

/** A user turn takes the next number; anything else joins its host prompt, else the latest one. */
function assignPromptNumber(db: Database, sessionId: number, event: NormalizedEvent): number | null {
  if (event.kind === 'user_prompt' && event.isUserTurn !== false) {
    const promptNumber = latestPromptNumber(db, sessionId) + 1
    insertPrompt(db, {
      sessionId,
      promptNumber,
      text: event.promptText ?? '',
      occurredAt: event.occurredAt,
      ...(event.hostPromptId !== undefined ? { hostPromptId: event.hostPromptId } : {}),
    })
    // The hook asked for recall right after it spooled this prompt, so that row is usually here before the prompt is.
    stampInjectionPrompts(db, { sessionId, host: event.host, hostSessionId: event.hostSessionId, promptNumber, occurredAt: event.occurredAt })
    return promptNumber
  }
  if (event.hostPromptId !== undefined) {
    const matched = promptNumberForHostId(db, sessionId, event.hostPromptId)
    if (matched !== null) return matched
  }
  const latest = latestPromptNumber(db, sessionId)
  return latest === 0 ? null : latest
}

/** Returns false for an event_id already stored. Checked first so a retried prompt never takes a second number. A stored turn_end whose usage can be read is added to `turnEnds`. */
function ingestEvent(db: Database, raw: NormalizedEvent, options: DrainOptions, now: number, turnEnds: TurnEnd[]): boolean {
  if (eventExists(db, raw.eventId)) return false
  const event = secondPass(raw, options)
  // The key the memory lives under: an alias's target, or the repo's winner when this key's first commit matches another project.
  const resolved = options.projectKeyFor(event.cwd)
  const project = { ...resolved, key: registerProject(db, resolved, now) }
  const sessionId = upsertSession(db, {
    host: event.host,
    hostSessionId: event.hostSessionId,
    projectKey: project.key,
    cwd: event.cwd,
    occurredAt: event.occurredAt,
    device: options.device === undefined ? LOCAL_DEVICE : options.device,
    ...(event.hostVersion !== undefined ? { hostVersion: event.hostVersion } : {}),
  })
  if (event.kind === 'session_end') markSessionEnded(db, sessionId, event.occurredAt)

  const promptNumber = assignPromptNumber(db, sessionId, event)
  // The reply is kept with its prompt, under prompts retention; the event keeps its copy for the observer until events retention takes it.
  if (event.kind === 'turn_end' && promptNumber !== null && event.assistantText !== undefined && event.assistantText !== '') {
    setPromptReply(db, sessionId, promptNumber, event.assistantText)
  }
  const inserted = insertEvent(db, {
    eventId: event.eventId,
    sessionId,
    promptNumber,
    kind: event.kind,
    toolName: event.tool?.name ?? null,
    payload: JSON.stringify(event),
    withheld: event.tool?.withheld ?? null,
    redactions: JSON.stringify(event.redactions ?? []),
    contentHash: contentHash(event),
    occurredAt: event.occurredAt,
    ingestedAt: now,
  })
  if (inserted && event.kind === 'turn_end' && promptNumber !== null && event.transcriptPath !== undefined && HOLDOUT_HOSTS.includes(event.host)) {
    turnEnds.push({ sessionId, promptNumber, host: event.host, projectKey: project.key, transcriptPath: event.transcriptPath, occurredAt: event.occurredAt })
  }
  return inserted
}

/** One batch in one transaction. The turn ends are handed back only when it commits, so nothing is read for rows that rolled back. */
function commitBatch(db: Database, entries: readonly SpoolEntry[], options: DrainOptions): { inserted: number; turnEnds: TurnEnd[] } {
  const now = (options.now ?? Date.now)()
  return db.transaction(() => {
    const turnEnds: TurnEnd[] = []
    const inserted = entries.filter((entry) => ingestEvent(db, entry.event, options, now, turnEnds)).length
    return { inserted, turnEnds }
  })()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** An event whose project another machine already resolved: what a hub stores for a device. */
export interface ResolvedEvent {
  event: NormalizedEvent
  project: ProjectKey
}

/**
 * Stores events whose project keys were resolved elsewhere, all in one
 * transaction. A transcript path names a file on the device, which this
 * machine must never read, so it is dropped before the event is stored.
 */
export function ingestResolved(db: Database, items: readonly ResolvedEvent[], options: PrepareOptions & { now?: () => number; device?: string | null }): { inserted: number; duplicates: number } {
  const now = (options.now ?? Date.now)()
  const inserted = db.transaction(() => items.filter((item) => {
    const { transcriptPath: _local, ...event } = item.event
    // Captured on another machine: its device id when the caller knows it, never this machine's mark.
    return ingestEvent(db, event, { ...options, device: options.device ?? null, spoolDir: '', projectKeyFor: () => item.project }, now, [])
  }).length)()
  return { inserted, duplicates: items.length - inserted }
}

/** Drains until the spool is empty or a batch fails. Quarantined entries are reported, never ingested. */
export function drainSpool(db: Database, options: DrainOptions): DrainResult {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  let result: DrainResult = { read: 0, inserted: 0, duplicates: 0, removed: 0, quarantined: [], turnEnds: [] }

  for (;;) {
    let batch: SpoolRead
    try {
      batch = readSpool(options.spoolDir, batchSize)
    } catch (error: unknown) {
      return { ...result, error: `spool read failed: ${errorMessage(error)}` }
    }
    result = { ...result, read: result.read + batch.entries.length, quarantined: [...result.quarantined, ...batch.quarantined] }
    if (batch.entries.length === 0) return result

    let inserted: number
    let turnEnds: TurnEnd[]
    try {
      ;({ inserted, turnEnds } = commitBatch(db, batch.entries, options))
    } catch (error: unknown) {
      return { ...result, error: `batch rolled back: ${errorMessage(error)}` }
    }
    for (const entry of batch.entries) removeSpoolEntry(entry.path)
    result = {
      ...result,
      inserted: result.inserted + inserted,
      duplicates: result.duplicates + batch.entries.length - inserted,
      removed: result.removed + batch.entries.length,
      turnEnds: [...result.turnEnds, ...turnEnds],
    }
    if (batch.entries.length < batchSize) return result
  }
}
