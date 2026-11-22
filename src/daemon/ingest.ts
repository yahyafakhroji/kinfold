// Spool -> SQLite. One transaction per batch, and spool files are removed only
// after it commits: a crash or a failed insert leaves the files for the next
// drain, and event_id makes the retry a no-op for rows that did land.
// No observer work here: rows wait with observer_state 'pending'.

import { createHash } from 'node:crypto'
import type { PrepareOptions } from '../capture/prepare'
import type { NormalizedEvent } from '../contract/event'
import { type QuarantinedEntry, type SpoolCursor, type SpoolEntry, type SpoolRead, createSpoolCursor, removeSpoolEntry } from '../spool/spool'
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
import { errorMessage } from '../errors'
import { secondPass } from '../capture/second-pass'

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

export { secondPass }

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

/**
 * One batch in one transaction. The turn ends are handed back only when it commits, so nothing is read for rows that rolled back.
 * Each folder's project key is asked for once, before the transaction opens: the lookup can run git, and a slow git must not hold the write lock.
 */
function commitBatch(db: Database, entries: readonly SpoolEntry[], options: DrainOptions): { inserted: number; turnEnds: TurnEnd[] } {
  const now = (options.now ?? Date.now)()
  const keys = new Map<string, ProjectKey>()
  for (const entry of entries) {
    if (!keys.has(entry.event.cwd)) keys.set(entry.event.cwd, options.projectKeyFor(entry.event.cwd))
  }
  const resolved: DrainOptions = { ...options, projectKeyFor: (cwd) => keys.get(cwd) ?? options.projectKeyFor(cwd) }
  return db.transaction(() => {
    const turnEnds: TurnEnd[] = []
    const inserted = entries.filter((entry) => ingestEvent(db, entry.event, resolved, now, turnEnds)).length
    return { inserted, turnEnds }
  })()
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

export interface BatchResult extends DrainResult {
  /** Entries from the cursor's listing still wait: the caller runs another batch, after letting other work through. */
  more: boolean
}

/**
 * Stores one batch (batchSize entries at most) from `cursor` and stops, so a
 * caller with other work to answer (the daemon) can do it between batches. A
 * read or commit that fails resets the cursor: those entries are still on disk.
 */
export function drainBatch(db: Database, options: DrainOptions, cursor: SpoolCursor): BatchResult {
  const empty: DrainResult = { read: 0, inserted: 0, duplicates: 0, removed: 0, quarantined: [], turnEnds: [] }
  let batch: SpoolRead & { more: boolean }
  try {
    batch = cursor.next(options.batchSize ?? DEFAULT_BATCH_SIZE)
  } catch (error: unknown) {
    cursor.reset()
    return { ...empty, more: false, error: `spool read failed: ${errorMessage(error)}` }
  }
  const read = { ...empty, read: batch.entries.length, quarantined: batch.quarantined }
  if (batch.entries.length === 0) return { ...read, more: batch.more }

  let inserted: number
  let turnEnds: TurnEnd[]
  try {
    ;({ inserted, turnEnds } = commitBatch(db, batch.entries, options))
  } catch (error: unknown) {
    cursor.reset()
    return { ...read, more: false, error: `batch rolled back: ${errorMessage(error)}` }
  }
  for (const entry of batch.entries) removeSpoolEntry(entry.path)
  return { ...read, inserted, duplicates: batch.entries.length - inserted, removed: batch.entries.length, turnEnds, more: batch.more }
}

/** Drains until the spool's listing is used up or a batch fails. Quarantined entries are reported, never ingested. */
export function drainSpool(db: Database, options: DrainOptions): DrainResult {
  const cursor = createSpoolCursor(options.spoolDir)
  const result: DrainResult = { read: 0, inserted: 0, duplicates: 0, removed: 0, quarantined: [], turnEnds: [] }

  for (;;) {
    const { more, error, ...batch } = drainBatch(db, options, cursor)
    result.read += batch.read
    result.inserted += batch.inserted
    result.duplicates += batch.duplicates
    result.removed += batch.removed
    result.quarantined.push(...batch.quarantined)
    result.turnEnds.push(...batch.turnEnds)
    if (error !== undefined) return { ...result, error }
    if (!more) return result
  }
}
