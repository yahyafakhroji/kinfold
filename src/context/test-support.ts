// Test scaffolding for context packs: seeds observations and summaries with
// synthetic titles into a temp store. Tests only; nothing in the daemon imports it.

import type { Store } from '../store/db'
import { insertObservation, upsertSummary } from '../store/observer-store'
import type { EvidenceStrength } from '../evidence'

export interface SeedObservation {
  sessionId: number
  projectKey: string
  host: string
  title: string
  evidence?: EvidenceStrength
  at: number
}

export const NARRATIVE_MARKER = 'NARRATIVE-THAT-MUST-NOT-BE-INJECTED'

let sequence = 0

/** Returns the new observation id. */
export function seedObservation(store: Store, seed: SeedObservation): number {
  sequence += 1
  insertObservation(store.db, {
    projectKey: seed.projectKey,
    sessionId: seed.sessionId,
    host: seed.host,
    promptNumber: 1,
    type: 'discovery',
    title: seed.title,
    narrative: NARRATIVE_MARKER,
    facts: '[]',
    files: '[]',
    evidence: seed.evidence ?? 'tool-verified',
    sourceEventIds: '[]',
    observerModel: 'fake-model',
    contentHash: `hash-${sequence}-${seed.title}`,
    occurredAt: seed.at,
    createdAt: seed.at,
  })
  const row = store.db.query<{ id: number }, []>('SELECT max(id) AS id FROM observations').get()
  return row!.id
}

export function contradict(store: Store, id: number, by: number): void {
  store.db.query('UPDATE observations SET contradicted_by = $by WHERE id = $id').run({ id, by })
}

export function seedSummary(store: Store, sessionId: number, nextSteps: string, at: number): void {
  upsertSummary(store.db, { sessionId, promptNumber: 1, request: 'r', learned: 'l', completed: 'c', nextSteps, occurredAt: at, updatedAt: at })
}
