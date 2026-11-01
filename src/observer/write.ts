// Turns a validated observer reply into rows. Each observation gets the
// daemon's evidence verdict (never the model's claim), the time of its latest
// cited event as occurred_at, and a content hash that makes a retried batch a
// no-op. The summary belongs to the latest prompt the batch covers, or is
// shared with an identical earlier prompt of the project.
// Relations become links from the stored row (or, on a retry, the row the
// first attempt stored), and the rows they name are settled in the same
// transaction (src/store/observation-links.ts holds the evidence rule).

import { createHash } from 'node:crypto'
import type { Database } from '../sqlite/types'
import {
  type ObservationRow,
  type ObserverSession,
  finishRun,
  insertObservation,
  markDone,
} from '../store/observer-store'
import { insertLinks, observationIdByHash, settleContradictions } from '../store/observation-links'
import { type SummaryWrite, writeSharedSummary } from '../store/summary-share'
import { finalStrength } from './sources'
import type { ObserverEvent, ObserverOutput, ParsedObservation } from './types'

export interface WriteCounts {
  observations: number
  inserted: number
  downgraded: number
  summary: boolean
  /** The summary is one an identical earlier prompt of the project wrote (P1-I). */
  summaryShared?: boolean
  /** Links stored by this batch, and rows those links hid. */
  links: number
  contradicted: number
}

export function observationHash(observation: ParsedObservation): string {
  const hash = createHash('sha256')
  const parts = [observation.type, observation.title, observation.narrative, JSON.stringify(observation.facts), JSON.stringify(observation.files)]
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

function latest<T>(values: readonly (T | null)[], pick: (a: T, b: T) => T): T | null {
  return values.reduce<T | null>((best, value) => (value === null ? best : best === null ? value : pick(best, value)), null)
}

export function observationRow(
  observation: ParsedObservation,
  batch: readonly ObserverEvent[],
  session: ObserverSession,
  model: string,
  now: number,
): ObservationRow {
  const cited = new Set(observation.evidence.sourceEventIds)
  const sources = batch.filter((event) => cited.has(event.eventId))
  return {
    projectKey: session.projectKey,
    sessionId: session.id,
    host: session.host,
    promptNumber: latest(sources.map((event) => event.promptNumber), Math.max),
    type: observation.type,
    title: observation.title,
    narrative: observation.narrative,
    facts: JSON.stringify(observation.facts),
    files: JSON.stringify(observation.files),
    evidence: finalStrength(observation, batch),
    sourceEventIds: JSON.stringify(observation.evidence.sourceEventIds),
    observerModel: model,
    contentHash: observationHash(observation),
    occurredAt: latest(sources.map((event) => event.occurredAt), Math.max) ?? now,
    createdAt: now,
  }
}

/** A repeat of a summarized prompt shares that summary even when the observer returned none (src/store/summary-share.ts). */
function writeSummary(db: Database, output: ObserverOutput, batch: readonly ObserverEvent[], session: ObserverSession, now: number): SummaryWrite {
  const promptNumber = latest(batch.map((event) => event.promptNumber), Math.max)
  if (promptNumber === null) return 'none'
  return writeSharedSummary(db, {
    sessionId: session.id,
    projectKey: session.projectKey,
    promptNumber,
    summary: output.summary,
    occurredAt: latest(batch.map((event) => event.occurredAt), Math.max) ?? now,
    now,
  })
}

function writeLinks(db: Database, rows: readonly { observation: ParsedObservation; row: ObservationRow }[], now: number): { links: number; contradicted: number } {
  let links = 0
  const targets: number[] = []
  for (const { observation, row } of rows) {
    if (observation.relations.length === 0) continue
    const fromId = observationIdByHash(db, row.projectKey, row.contentHash)
    if (fromId === null) continue
    links += insertLinks(db, fromId, observation.relations, now)
    targets.push(...observation.relations.filter((relation) => relation.kind !== 'confirms').map((relation) => relation.observationId))
  }
  return { links, contradicted: settleContradictions(db, targets) }
}

/** One transaction: rows, events done, run succeeded. A failure rolls all of it back and the caller records it. */
export function writeBatchResult(
  db: Database,
  input: { runId: number; output: ObserverOutput; batch: readonly ObserverEvent[]; session: ObserverSession; model: string; now: number },
): WriteCounts {
  const { runId, output, batch, session, model, now } = input
  return db.transaction(() => {
    const rows = output.observations.map((observation) => ({ observation, row: observationRow(observation, batch, session, model, now) }))
    const inserted = rows.filter(({ row }) => insertObservation(db, row)).length
    const downgraded = rows.filter(({ observation, row }) => observation.evidence.strength !== row.evidence).length
    const linked = writeLinks(db, rows, now)
    const summary = writeSummary(db, output, batch, session, now)
    markDone(db, batch.map((event) => event.eventId))
    finishRun(db, runId, 'succeeded', null, now, model)
    return { observations: rows.length, inserted, downgraded, summary: summary !== 'none', summaryShared: summary === 'shared', ...linked }
  })()
}
