// Memory echo guard. A session that was handed past observations tends to
// restate them, and an observer reading that session would store each
// restatement as a new observation, so every session would add another copy
// of what it was told (seen live: four of seven new observations repeated the
// injected pack). The observer is shown what this session received, and an
// observation below tool-verified that near-duplicates one of those titles is
// dropped. A tool-verified one is kept: a fresh tool result confirming an old
// fact is new evidence, and the pack merge already shows it as one line. One
// that updates or contradicts a shown entry is kept too: its title is often
// close to the old one, and the link is the point of it.

import { basename } from 'node:path'
import { isNearDuplicate, nameTokens, titleTokens } from '../context/similarity'
import type { Database } from '../sqlite/types'
import { finalStrength } from './sources'
import type { ObserverEvent, ParsedObservation } from './types'

export const MAX_KNOWN_OBSERVATIONS = 40

export interface KnownObservation {
  id: number
  title: string
  /** Relations may only name entries in the session's own project. */
  projectKey: string
}

export interface EchoFilterResult {
  kept: ParsedObservation[]
  echoes: number
}

/** Our own column; a value that is not a JSON array of ids names no observations. */
function parseIds(json: string): number[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((id): id is number => Number.isSafeInteger(id)) : []
  } catch {
    return []
  }
}

/** Ids a relation may name: what the run showed, narrowed to the session's project. */
export function linkableIds(known: readonly KnownObservation[], projectKey: string): number[] {
  return known.filter((item) => item.projectKey === projectKey).map((item) => item.id)
}

/** SessionStart injections carry no session_id, so they match on (host, host_session_id). */
export function injectedObservations(db: Database, sessionId: number): KnownObservation[] {
  const rows = db.query<{ ids: string }, { sessionId: number }>(
    `SELECT i.observation_ids AS ids FROM injections i JOIN sessions s ON s.id = $sessionId
     WHERE i.session_id = s.id OR (i.session_id IS NULL AND i.host = s.host AND i.host_session_id = s.host_session_id)
     ORDER BY i.id`,
  ).all({ sessionId })
  const ids = [...new Set(rows.flatMap((row) => parseIds(row.ids)))].slice(0, MAX_KNOWN_OBSERVATIONS)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  return db.query<KnownObservation, number[]>(`SELECT id, title, project_key AS projectKey FROM observations WHERE id IN (${placeholders}) ORDER BY id`).all(...ids)
}

/** Titles compare as the pack merge compares them: project-name tokens ignored, Jaccard at the shared threshold. */
export function dropEchoes(
  observations: readonly ParsedObservation[],
  known: readonly KnownObservation[],
  batch: readonly ObserverEvent[],
  projectKey: string,
): EchoFilterResult {
  if (known.length === 0) return { kept: [...observations], echoes: 0 }
  const ignore = nameTokens(basename(projectKey))
  const knownTokens = known.map((item) => titleTokens(item.title, ignore))
  const kept = observations.filter((observation) => {
    if (finalStrength(observation, batch) === 'tool-verified') return true
    if (observation.relations.some((relation) => relation.kind !== 'confirms')) return true
    const tokens = titleTokens(observation.title, ignore)
    return !knownTokens.some((item) => isNearDuplicate(item, tokens))
  })
  return { kept, echoes: observations.length - kept.length }
}
