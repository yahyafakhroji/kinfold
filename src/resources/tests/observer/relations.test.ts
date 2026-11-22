import { afterEach, beforeEach, expect, test } from 'bun:test'
import { upsertProject } from '../store/writes'
import { processSessionBatch } from './process'
import { BEGIN_KNOWN } from './prompt'
import { PROJECT, type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession } from './test-support'
import type { ObserverPrompt } from './types'

let temp: TempStore
let logs: string[]
beforeEach(() => {
  temp = openTempStore('sam-relations-')
  logs = []
})
afterEach(() => temp.cleanup())

const SECRETISH = 'PAYLOAD-TEXT-THAT-MUST-NOT-BE-LOGGED'

function seedKnown(project: string, title: string, evidence: string): number {
  const result = temp.store.db.query(
    `INSERT INTO observations (project_key, host, type, title, evidence, content_hash, occurred_at, created_at)
     VALUES (?, 'opencode', 'discovery', ?, ?, ?, ?, ?)`,
  ).run(project, title, evidence, `hash-${title}`, T0 - 1_000, T0 - 1_000)
  return Number(result.lastInsertRowid)
}

function inject(sessionId: number, ids: number[]): void {
  temp.store.db.query(
    `INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at)
     VALUES (?, 'claude-code', 's1', ?, ?, 'session_start', 10, ?)`,
  ).run(sessionId, PROJECT, JSON.stringify(ids), T0)
}

function seedTurn(sessionId: number, at: number, promptNumber: number): void {
  seedEvent(temp.store, sessionId, { kind: 'user_prompt', at, promptNumber, promptText: `check the route ${SECRETISH}` })
  seedEvent(temp.store, sessionId, { kind: 'tool_result', at: at + 10, promptNumber, tool: { name: 'Bash', output: `3 matches ${SECRETISH}`, exitCode: 0 } })
  seedEvent(temp.store, sessionId, { kind: 'turn_end', at: at + 20, promptNumber, assistantText: 'done' })
}

function contradictingReply(known: number, foreign: number): (prompt: ObserverPrompt) => string {
  return (prompt) => JSON.stringify({
    observations: [{
      type: 'discovery', title: 'Semantic route returns 3 matches', narrative: '', facts: [], files: [],
      evidence: { strength: 'tool-verified', sourceEventIds: [prompt.eventIds[1]] },
      relations: [{ kind: 'contradicts', observationId: `#${known}` }, { kind: 'contradicts', observationId: foreign }, { kind: 'updates', observationId: 999 }],
    }],
    summary: null,
  })
}

const run = (sessionId: number, reply: (prompt: ObserverPrompt) => string) =>
  processSessionBatch({ db: temp.store.db, runnerFor: () => fakeRunner([reply]), now: () => T0 + 60_000, log: (line) => logs.push(line) }, sessionId)

test('a contradiction against a shown id is stored and hides the old row; foreign and unshown ids are dropped and counted', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  upsertProject(temp.store.db, { key: 'other/repo', kind: 'git-remote', displayName: 'other' }, T0)
  const known = seedKnown(PROJECT, 'Semantic route returns empty', 'interpretation')
  const foreign = seedKnown('other/repo', 'Unrelated fact', 'interpretation')
  inject(session, [known, foreign])
  seedTurn(session, T0, 1)

  const runner = fakeRunner([contradictingReply(known, foreign)])
  const outcome = await processSessionBatch({ db: temp.store.db, runnerFor: () => runner, now: () => T0 + 60_000, log: (line) => logs.push(line) }, session)
  expect(runner.prompts[0]?.user).toContain(BEGIN_KNOWN)
  expect(runner.prompts[0]?.user).toContain(`#${foreign} Unrelated fact`)
  expect(outcome).toMatchObject({ status: 'succeeded', inserted: 1, links: 1, contradicted: 1, droppedRelations: 2 })

  const newId = (temp.store.db.query("SELECT id FROM observations WHERE title = 'Semantic route returns 3 matches'").get() as { id: number }).id
  expect(temp.store.db.query('SELECT from_id, to_id, kind FROM observation_links').all()).toEqual([{ from_id: newId, to_id: known, kind: 'contradicts' }])
  expect(temp.store.db.query('SELECT id, contradicted_by FROM observations WHERE id IN (?, ?) ORDER BY id').all(known, foreign)).toEqual([
    { id: known, contradicted_by: newId },
    { id: foreign, contradicted_by: null },
  ])
  expect(logs.join('\n')).toContain('links=1 contradicted=1 relations_dropped=2')
  expect(logs.join('\n')).not.toContain(SECRETISH)
})

test('the same observation from a later batch finds its stored row by content hash and adds no link twice', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  const known = seedKnown(PROJECT, 'Semantic route returns empty', 'interpretation')
  inject(session, [known])
  seedTurn(session, T0, 1)
  const first = await run(session, contradictingReply(known, 999))
  seedTurn(session, T0 + 1_000, 2)
  const second = await run(session, contradictingReply(known, 999))
  expect(first).toMatchObject({ status: 'succeeded', inserted: 1, links: 1, contradicted: 1 })
  expect(second).toMatchObject({ status: 'succeeded', inserted: 0, links: 0, contradicted: 0 })
  expect(temp.store.db.query('SELECT count(*) AS n FROM observation_links').get()).toEqual({ n: 1 })
  expect(temp.store.db.query('SELECT count(*) AS n FROM observations').get()).toEqual({ n: 2 })
})

test('an interpretation that contradicts a tool-verified row is linked but the row stays visible', async () => {
  const session = seedSession(temp.store, 'claude-code', 's1')
  const known = seedKnown(PROJECT, 'Spool drains in host-time order', 'tool-verified')
  inject(session, [known])
  seedTurn(session, T0, 1)
  const outcome = await run(session, (prompt) => JSON.stringify({
    observations: [{
      type: 'discovery', title: 'Spool order looks random', narrative: '', facts: [], files: [],
      evidence: { strength: 'interpretation', sourceEventIds: [prompt.eventIds[2]] },
      relations: [{ kind: 'contradicts', observationId: known }],
    }],
    summary: null,
  }))
  expect(outcome).toMatchObject({ status: 'succeeded', links: 1, contradicted: 0 })
  expect(temp.store.db.query('SELECT contradicted_by FROM observations WHERE id = ?').get(known)).toEqual({ contradicted_by: null })
})
