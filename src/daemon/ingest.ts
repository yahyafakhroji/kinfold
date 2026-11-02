// Spool -> SQLite. One transaction per batch, and spool files are removed only
// after it commits: a crash or a failed insert leaves the files for the next
// drain, and event_id makes the retry a no-op for rows that did land.
// No observer work here: rows wait with observer_state 'pending'.

import { createHash } from 'node:crypto'
import { DEFAULT_MAX_FIELD_CHARS, type PrepareOptions, type RedactedEvent, prepareForSpool } from '../capture/prepare'
import type { NormalizedEvent } from '../contract/event'
import { type QuarantinedEntry, type SpoolEntry, type SpoolRead, readSpool, removeSpoolEntry } from '../spool/spool'
import type { Database } from '../sqlite/types'
import type { ProjectKeyResolver } from '../store/project-key'
import {
  eventExists,
  insertEvent,
  insertPrompt,
  latestPromptNumber,
  markSessionEnded,
  promptNumberForHostId,
  upsertProject,
  upsertSession,
} from '../store/writes'

export interface DrainOptions extends PrepareOptions {
  spoolDir: string
  projectKeyFor: ProjectKeyResolver
  batchSize?: number
  now?: () => number
}

export interface DrainResult {
  read: number
  inserted: number
  duplicates: number
  removed: number
  quarantined: QuarantinedEntry[]
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
    return promptNumber
  }
  if (event.hostPromptId !== undefined) {
    const matched = promptNumberForHostId(db, sessionId, event.hostPromptId)
    if (matched !== null) return matched
  }
  const latest = latestPromptNumber(db, sessionId)
  return latest === 0 ? null : latest
}

/** Returns false for an event_id already stored. Checked first so a retried prompt never takes a second number. */
function ingestEvent(db: Database, raw: NormalizedEvent, options: DrainOptions, now: number): boolean {
  if (eventExists(db, raw.eventId)) return false
  const event = secondPass(raw, options)
  const project = options.projectKeyFor(event.cwd)
  upsertProject(db, project, now)
  const sessionId = upsertSession(db, {
    host: event.host,
    hostSessionId: event.hostSessionId,
    projectKey: project.key,
    cwd: event.cwd,
    occurredAt: event.occurredAt,
    ...(event.hostVersion !== undefined ? { hostVersion: event.hostVersion } : {}),
  })
  if (event.kind === 'session_end') markSessionEnded(db, sessionId, event.occurredAt)

  return insertEvent(db, {
    eventId: event.eventId,
    sessionId,
    promptNumber: assignPromptNumber(db, sessionId, event),
    kind: event.kind,
    toolName: event.tool?.name ?? null,
    payload: JSON.stringify(event),
    withheld: event.tool?.withheld ?? null,
    redactions: JSON.stringify(event.redactions ?? []),
    contentHash: contentHash(event),
    occurredAt: event.occurredAt,
    ingestedAt: now,
  })
}

function commitBatch(db: Database, entries: readonly SpoolEntry[], options: DrainOptions): number {
  const now = (options.now ?? Date.now)()
  return db.transaction(() => entries.filter((entry) => ingestEvent(db, entry.event, options, now)).length)()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Drains until the spool is empty or a batch fails. Quarantined entries are reported, never ingested. */
export function drainSpool(db: Database, options: DrainOptions): DrainResult {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  let result: DrainResult = { read: 0, inserted: 0, duplicates: 0, removed: 0, quarantined: [] }

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
    try {
      inserted = commitBatch(db, batch.entries, options)
    } catch (error: unknown) {
      return { ...result, error: `batch rolled back: ${errorMessage(error)}` }
    }
    for (const entry of batch.entries) removeSpoolEntry(entry.path)
    result = {
      ...result,
      inserted: result.inserted + inserted,
      duplicates: result.duplicates + batch.entries.length - inserted,
      removed: result.removed + batch.entries.length,
    }
    if (batch.entries.length < batchSize) return result
  }
}
