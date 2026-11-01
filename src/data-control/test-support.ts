// Test scaffolding for data control: a temp store seeded with two projects,
// three sessions over two hosts, events, prompts, observations, a summary,
// injections and built packs. Text that must disappear carries a marker
// unique to its owner, so a test can grep the database file for it.
// Tests only; nothing in the daemon imports it.

import { rebuildProjectPacks } from '../context/packs'
import { seedObservation, seedSummary } from '../context/test-support'
import { type TempStore, T0, openTempStore, seedEvent } from '../observer/test-support'
import { recordInjection } from '../store/context-store'
import { insertPrompt, upsertProject, upsertSession } from '../store/writes'

/** A key fragment of the shape the key_fragment rule (rules v2) catches and v1 kept: `sk-or-v1-` plus five characters. */
export const FRAGMENT = 'sk-or-v1-' + 'Qz7Wx'
export const HMAC_KEY = 'data-control-test-hmac-key'
export const DAY = 86_400_000

export interface Fixture {
  temp: TempStore
  projectA: string
  projectB: string
  /** claude-code in A, opencode in A, claude-code in B. */
  sessions: { a1: number; a2: number; b1: number }
  observations: { a1: number; a2: number; b1: number }
  events: { a1: string; a2: string; b1: string }
}

/** Lowercase single tokens: FTS stores terms lowercased, so the grep sees the same bytes. */
export const MARKERS = { a1: 'qxalphamarker', a2: 'qxbetamarker', b1: 'qxgammamarker' } as const

function seedOwned(temp: TempStore, sessionId: number, projectKey: string, host: string, marker: string, at: number): { observation: number; event: string } {
  const event = seedEvent(temp.store, sessionId, { kind: 'tool_result', at, promptNumber: 1, tool: { name: 'Bash', output: `output ${marker} done`, exitCode: 0 } })
  insertPrompt(temp.store.db, { sessionId, promptNumber: 1, text: `prompt about ${marker}`, occurredAt: at })
  const observation = seedObservation(temp.store, { sessionId, projectKey, host, title: `Observed ${marker} works`, at })
  return { observation, event }
}

export function seedFixture(prefix: string): Fixture {
  const temp = openTempStore(prefix)
  const db = temp.store.db
  const projectA = 'org/alpha'
  const projectB = 'org/beta'
  upsertProject(db, { key: projectA, kind: 'git-remote', displayName: 'alpha' }, T0)
  upsertProject(db, { key: projectB, kind: 'git-remote', displayName: 'beta' }, T0)
  const sessions = {
    a1: upsertSession(db, { host: 'claude-code', hostSessionId: 'cc-a1', projectKey: projectA, cwd: '/w/alpha', occurredAt: T0 }),
    a2: upsertSession(db, { host: 'opencode', hostSessionId: 'oc-a2', projectKey: projectA, cwd: '/w/alpha', occurredAt: T0 + DAY }),
    b1: upsertSession(db, { host: 'claude-code', hostSessionId: 'cc-b1', projectKey: projectB, cwd: '/w/beta', occurredAt: T0 + 2 * DAY }),
  }
  const a1 = seedOwned(temp, sessions.a1, projectA, 'claude-code', MARKERS.a1, T0)
  const a2 = seedOwned(temp, sessions.a2, projectA, 'opencode', MARKERS.a2, T0 + DAY)
  const b1 = seedOwned(temp, sessions.b1, projectB, 'claude-code', MARKERS.b1, T0 + 2 * DAY)
  seedSummary(temp.store, sessions.a1, `next for ${MARKERS.a1}`, T0)
  const inject = (sessionId: number, hostSessionId: string, projectKey: string, ids: number[]): number =>
    recordInjection(db, { sessionId, host: 'claude-code', hostSessionId, projectKey, observationIds: ids, channel: 'session_start', tokens: 10, occurredAt: T0 })
  inject(sessions.a1, 'cc-a1', projectA, [a1.observation])
  inject(sessions.a2, 'oc-a2', projectA, [a1.observation, a2.observation])
  rebuildProjectPacks(db, projectA, T0 + 3 * DAY)
  rebuildProjectPacks(db, projectB, T0 + 3 * DAY)
  return {
    temp,
    projectA,
    projectB,
    sessions,
    observations: { a1: a1.observation, a2: a2.observation, b1: b1.observation },
    events: { a1: a1.event, a2: a2.event, b1: b1.event },
  }
}

export function count(temp: TempStore, table: string): number {
  return temp.store.db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0
}

export const COUNTED_TABLES = ['sessions', 'events', 'prompts', 'observations', 'summaries', 'injections', 'context_packs', 'projects', 'redaction_findings'] as const

export function tableCounts(temp: TempStore): Record<string, number> {
  return Object.fromEntries(COUNTED_TABLES.map((table) => [table, count(temp, table)]))
}

/** FTS ids matching one term. */
export function ftsMatch(temp: TempStore, term: string): number[] {
  return temp.store.db.query<{ id: number }, { term: string }>('SELECT rowid AS id FROM observations_fts WHERE observations_fts MATCH $term')
    .all({ term }).map((row) => row.id)
}

/** Simulates a row written before rules v2: the version a v3 database migrates to. */
export function markV1(temp: TempStore, table: string): void {
  temp.store.db.run(`UPDATE ${table} SET rules_version = 1, scanned_version = 1`)
}
