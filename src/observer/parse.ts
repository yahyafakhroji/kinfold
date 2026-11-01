// Validates what the observer model returned. The reply is untrusted text, so
// it has to match the contract exactly: a shape error rejects the whole reply
// (the batch is retried), while a citation the batch never contained is
// dropped, and an observation left with no valid citation, or with a type
// outside the list, is dropped on its own. Relations work like citations: a
// link to an id the run never showed as memory (or one from another project)
// is dropped and counted, never stored.

import { isRecord } from '../contract/event'
import type { EvidenceStrength } from '../evidence'
import {
  EVIDENCE_STRENGTHS,
  OBSERVATION_TYPES,
  RELATION_KINDS,
  type ObservationRelation,
  type ObservationType,
  type ObserverOutput,
  type ParsedObservation,
  type ParsedSummary,
  type RelationKind,
} from './types'

export type ParseResult = { ok: true; output: ObserverOutput } | { ok: false; error: string }

export const FIELD_LIMITS = { title: 200, narrative: 2_000, item: 500, facts: 20, files: 50, summaryField: 2_000, observations: 30, relations: 10 } as const

/** Models echo the memory block's "#12" form, so a string of digits with an optional # is read as the id. */
const ID_TEXT = /^#?(\d{1,15})$/

const FENCED = /^```(?:json)?\s*\n([\s\S]*?)\n```$/

class ShapeError extends Error {}

function cap(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new ShapeError(`${where}.${key} must be a string`)
  return value
}

function stringList(value: unknown, where: string, maxItems: number): string[] {
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) {
    throw new ShapeError(`${where} must be an array of strings`)
  }
  return value.slice(0, maxItems).map((item) => cap(item, FIELD_LIMITS.item))
}

function parseEvidence(value: unknown, where: string): { strength: EvidenceStrength; cited: string[] } {
  if (!isRecord(value)) throw new ShapeError(`${where}.evidence must be an object`)
  const strength = value.strength
  if (!EVIDENCE_STRENGTHS.includes(strength as EvidenceStrength)) {
    throw new ShapeError(`${where}.evidence.strength must be one of ${EVIDENCE_STRENGTHS.join(', ')}`)
  }
  return { strength: strength as EvidenceStrength, cited: stringList(value.sourceEventIds, `${where}.evidence.sourceEventIds`, 100) }
}

interface Allowed {
  eventIds: ReadonlySet<string>
  knownIds: ReadonlySet<number>
}

interface ParsedEntry {
  observation: ParsedObservation | null
  dropped: number
  droppedRelations: number
}

function relationId(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  const match = typeof value === 'string' ? ID_TEXT.exec(value.trim()) : null
  return match?.[1] === undefined ? null : Number(match[1])
}

/** Absent means none. A malformed entry, an unknown kind or an id the run never showed is dropped, not fatal. */
function parseRelations(value: unknown, where: string, knownIds: ReadonlySet<number>): { relations: ObservationRelation[]; dropped: number } {
  if (value === undefined || value === null) return { relations: [], dropped: 0 }
  if (!Array.isArray(value)) throw new ShapeError(`${where}.relations must be an array`)
  const seen = new Set<string>()
  const relations: ObservationRelation[] = []
  for (const item of value.slice(0, FIELD_LIMITS.relations)) {
    const kind = isRecord(item) ? item.kind : undefined
    const id = isRecord(item) ? relationId(item.observationId) : null
    if (!RELATION_KINDS.includes(kind as RelationKind) || id === null || !knownIds.has(id)) continue
    const key = `${String(kind)}:${id}`
    if (seen.has(key)) continue
    seen.add(key)
    relations.push({ kind: kind as RelationKind, observationId: id })
  }
  return { relations, dropped: value.length - relations.length }
}

/** A null observation is one dropped on its own: an unknown type costs that observation, not the reply. */
function parseObservation(value: unknown, index: number, allowed: Allowed): ParsedEntry {
  const where = `observations[${index}]`
  if (!isRecord(value)) throw new ShapeError(`${where} must be an object`)
  const type = value.type
  if (!OBSERVATION_TYPES.includes(type as ObservationType)) return { observation: null, dropped: 0, droppedRelations: 0 }
  const title = requireString(value, 'title', where).trim()
  if (title === '') throw new ShapeError(`${where}.title must not be empty`)
  const evidence = parseEvidence(value.evidence, where)
  const { eventIds, knownIds } = allowed
  const valid = [...new Set(evidence.cited)].filter((id) => eventIds.has(id))
  const relations = parseRelations(value.relations, where, knownIds)
  return {
    observation: {
      type: type as ObservationType,
      title: cap(title, FIELD_LIMITS.title),
      narrative: cap(requireString(value, 'narrative', where), FIELD_LIMITS.narrative),
      facts: stringList(value.facts, `${where}.facts`, FIELD_LIMITS.facts),
      files: stringList(value.files, `${where}.files`, FIELD_LIMITS.files),
      evidence: { strength: evidence.strength, sourceEventIds: valid },
      relations: relations.relations,
    },
    dropped: evidence.cited.filter((id) => !eventIds.has(id)).length,
    droppedRelations: relations.dropped,
  }
}

function parseSummary(value: unknown): ParsedSummary | null {
  if (value === null) return null
  if (!isRecord(value)) throw new ShapeError('summary must be an object or null')
  // Models write null for a part with nothing to say (seen live from Haiku and
  // OpenRouter on turns that failed); that is an empty field, not a bad reply.
  const field = (key: string): string =>
    value[key] === null ? '' : cap(requireString(value, key, 'summary'), FIELD_LIMITS.summaryField)
  return { request: field('request'), learned: field('learned'), completed: field('completed'), nextSteps: field('nextSteps') }
}

/** Strict JSON; the one leniency is a reply wrapped whole in a single ``` fence. */
function parseJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = FENCED.exec(trimmed)
  try {
    return JSON.parse(fenced?.[1] ?? trimmed)
  } catch {
    throw new ShapeError('reply is not valid JSON')
  }
}

function validate(value: unknown, allowed: Allowed): ObserverOutput {
  if (!isRecord(value)) throw new ShapeError('reply must be a JSON object')
  if (!Array.isArray(value.observations)) throw new ShapeError('observations must be an array')
  if (!('summary' in value)) throw new ShapeError('summary is required (an object or null)')
  const parsed = value.observations.slice(0, FIELD_LIMITS.observations).map((item, index) => parseObservation(item, index, allowed))
  const kept = parsed
    .map((entry) => entry.observation)
    .filter((observation): observation is ParsedObservation => observation !== null && observation.evidence.sourceEventIds.length > 0)
  return {
    observations: kept,
    summary: parseSummary(value.summary),
    droppedIds: parsed.reduce((sum, entry) => sum + entry.dropped, 0),
    droppedObservations: parsed.length - kept.length,
    droppedRelations: parsed.reduce((sum, entry) => sum + entry.droppedRelations, 0),
  }
}

/**
 * Error messages name the failing field only; they never quote the reply.
 * knownIds are the prior-memory ids this run showed, already narrowed to the session's project.
 */
export function parseObserverOutput(text: string, batchEventIds: readonly string[], knownIds: readonly number[] = []): ParseResult {
  try {
    return { ok: true, output: validate(parseJson(text), { eventIds: new Set(batchEventIds), knownIds: new Set(knownIds) }) }
  } catch (error: unknown) {
    if (error instanceof ShapeError) return { ok: false, error: error.message }
    throw error
  }
}
