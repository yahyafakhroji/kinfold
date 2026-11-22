// Test scaffolding for the MCP server: a temp store with two projects, seeded
// observations of any type, host and evidence, a summary, and one event whose
// payload carries a marker no MCP answer may contain. Tests only.

import type { Store } from '../store/db'
import { insertObservation, upsertSummary } from '../store/observer-store'
import { upsertProject, upsertSession } from '../store/writes'
import { type TempStore, T0, openTempStore, seedEvent } from '../observer/test-support'
import type { EvidenceStrength } from '../evidence'
import type { GitRunner } from '../store/project-key'

export { T0 }

export const PROJECT_A = 'github.com/org/repo'
export const PROJECT_B = 'github.com/org/other'
export const PAYLOAD_MARKER = 'EVENT-PAYLOAD-MUST-NOT-LEAK'
export const NOW = T0 + 3 * 60 * 60 * 1000

/** A git runner that reports PROJECT_A's remote for any cwd. */
export const gitForProjectA: GitRunner = (_cwd, args) => (args[0] === 'config' ? 'git@github.com:org/repo.git' : null)

export interface McpSeed {
  sessionId: number
  projectKey: string
  title: string
  host?: string
  type?: string
  evidence?: EvidenceStrength
  narrative?: string
  facts?: string[]
  at: number
}

let sequence = 0

export function seedMcpSession(store: Store, projectKey: string, host: string, hostSessionId: string): number {
  upsertProject(store.db, { key: projectKey, kind: 'git-remote', displayName: projectKey.split('/').pop() ?? projectKey }, T0)
  return upsertSession(store.db, { host, hostSessionId, projectKey, cwd: '/work/repo', occurredAt: T0 })
}

/** Returns the new observation id. */
export function seedMcpObservation(store: Store, seed: McpSeed): number {
  sequence += 1
  insertObservation(store.db, {
    projectKey: seed.projectKey,
    sessionId: seed.sessionId,
    host: seed.host ?? 'claude-code',
    promptNumber: 1,
    type: seed.type ?? 'discovery',
    title: seed.title,
    narrative: seed.narrative ?? `Narrative for ${seed.title}`,
    facts: JSON.stringify(seed.facts ?? []),
    files: JSON.stringify(['src/a.ts']),
    evidence: seed.evidence ?? 'tool-verified',
    sourceEventIds: JSON.stringify(['01EVENTID']),
    observerModel: 'fake-model',
    contentHash: `mcp-${sequence}`,
    occurredAt: seed.at,
    createdAt: seed.at,
  })
  return (store.db.query('SELECT max(id) AS id FROM observations').get() as { id: number }).id
}

export function seedMcpSummary(store: Store, sessionId: number, at: number): void {
  upsertSummary(store.db, { sessionId, promptNumber: 1, request: 'fix the parser', learned: 'parser drops quotes', completed: 'parser fixed', nextSteps: 'add a test', occurredAt: at, updatedAt: at })
}

export function seedPayloadEvent(store: Store, sessionId: number): void {
  seedEvent(store, sessionId, { kind: 'tool_result', at: T0, tool: { name: 'Bash', output: `parser ${PAYLOAD_MARKER}` } })
}

export interface McpFixture extends TempStore {
  sessionA: number
  sessionB: number
  ids: Record<string, number>
}

/** Project A: five observations (one contradicted) and a summary; project B: one. */
export function openMcpFixture(): McpFixture {
  const temp = openTempStore('sam-mcp-')
  const { store } = temp
  const sessionA = seedMcpSession(store, PROJECT_A, 'claude-code', 'a-1')
  const sessionB = seedMcpSession(store, PROJECT_B, 'opencode', 'b-1')
  const minute = 60_000
  const ids = {
    parser: seedMcpObservation(store, { sessionId: sessionA, projectKey: PROJECT_A, title: 'Parser drops quoted strings', type: 'bugfix', at: T0 + minute }),
    redaction: seedMcpObservation(store, { sessionId: sessionA, projectKey: PROJECT_A, title: 'Redaction rules version two', host: 'opencode', evidence: 'interpretation', at: T0 + 2 * minute }),
    spool: seedMcpObservation(store, { sessionId: sessionA, projectKey: PROJECT_A, title: 'Spool keeps host event time', type: 'decision', at: T0 + 3 * minute }),
    oldParser: seedMcpObservation(store, { sessionId: sessionA, projectKey: PROJECT_A, title: 'Parser never drops strings', evidence: 'interpretation', at: T0 + 4 * minute }),
    tests: seedMcpObservation(store, { sessionId: sessionA, projectKey: PROJECT_A, title: 'Test suite passes', facts: ['406 tests pass'], at: T0 + 5 * minute }),
    other: seedMcpObservation(store, { sessionId: sessionB, projectKey: PROJECT_B, title: 'Parser in the other project', host: 'opencode', at: T0 + 6 * minute }),
  }
  store.db.query('UPDATE observations SET contradicted_by = $by WHERE id = $id').run({ id: ids.oldParser, by: ids.parser })
  seedMcpSummary(store, sessionA, T0 + 3 * minute + 30_000)
  seedPayloadEvent(store, sessionA)
  return { ...temp, sessionA, sessionB, ids }
}
