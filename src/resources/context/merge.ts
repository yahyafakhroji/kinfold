// Groups near-duplicate observations into one pack item. Observations arrive
// ranked (strongest evidence plus the confirmation boost, then newest; see
// confirmBoost in src/resources/store/observation-links.ts), so the first of a group is the one
// to show; later members only add the hosts that also saw it. Each candidate
// is compared with group leads, never with other members, so a chain of
// slightly different titles cannot drift into one group.

import { confirmBoost } from '../store/observation-links'
import { isNearDuplicate, titleTokens } from './similarity'
import { isStatusNote } from './status-notes'
import type { PackObservation } from './types'

export interface PackItem {
  lead: PackObservation
  members: readonly PackObservation[]
  /** Hosts other than the lead's that recorded the same fact, sorted. */
  alsoSeenBy: readonly string[]
}

const STRENGTH_RANK: Readonly<Record<PackObservation['evidence'], number>> = {
  'tool-verified': 3,
  'user-stated': 2,
  interpretation: 1,
}

/** Evidence tier plus the confirmation boost (below 1, so it never crosses a tier). */
export function rankScore(row: PackObservation): number {
  return STRENGTH_RANK[row.evidence] + confirmBoost(row.confirmedBy)
}

/** Lasting memory before status notes (status-notes.ts), then highest rank score, then newest, then highest id, so ties order the same way every build. */
export function compareStrength(a: PackObservation, b: PackObservation): number {
  return Number(isStatusNote(a.title)) - Number(isStatusNote(b.title)) || rankScore(b) - rankScore(a) || b.occurredAt - a.occurredAt || b.id - a.id
}

export function rankObservations(observations: readonly PackObservation[]): PackObservation[] {
  return [...observations].sort(compareStrength)
}

interface Group {
  lead: PackObservation
  tokens: ReadonlySet<string>
  members: PackObservation[]
}

function toItem(group: Group): PackItem {
  const hosts = new Set(group.members.map((member) => member.host).filter((host) => host !== group.lead.host))
  return { lead: group.lead, members: group.members, alsoSeenBy: [...hosts].sort() }
}

/** `ignore` holds tokens every title in the project may carry (its name). Returns items in rank order. */
export function mergeNearDuplicates(observations: readonly PackObservation[], ignore: ReadonlySet<string> = new Set()): PackItem[] {
  // The groups are this function's own, appended to in place: a copy of the whole list per observation made 600
  // candidates cost 600 list copies, three times per observer write (once per agent profile), inside its transaction.
  const groups: Group[] = []
  for (const observation of rankObservations(observations)) {
    const tokens = titleTokens(observation.title, ignore)
    const group = groups.find((known) => isNearDuplicate(known.tokens, tokens))
    if (group === undefined) groups.push({ lead: observation, tokens, members: [observation] })
    else group.members.push(observation)
  }
  return groups.map(toItem)
}
