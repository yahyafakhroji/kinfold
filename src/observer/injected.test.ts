import { afterEach, beforeEach, expect, test } from 'bun:test'
import { dropEchoes, injectedObservations } from './injected'
import { processSessionBatch } from './process'
import { BEGIN_KNOWN, buildObserverPrompt } from './prompt'
import { PROJECT, type TempStore, T0, fakeRunner, openTempStore, seedEvent, seedSession } from './test-support'
import type { ObserverEvent, ObserverPrompt, ParsedObservation } from './types'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-echo-')
})
afterEach(() => temp.cleanup())

function seedObservation(sessionId: number, title: string): number {
  const result = temp.store.db
    .query(
      `INSERT INTO observations (project_key, session_id, host, prompt_number, type, title, narrative, facts, files, evidence,
         source_event_ids, observer_model, content_hash, occurred_at, created_at)
       VALUES ('org/repo', ?, 'claude-code', 1, 'discovery', ?, '', '[]', '[]', 'tool-verified', '[]', 'fake', ?, ?, ?)`,
    )
    .run(sessionId, title, `hash-${title}`, T0, T0)
  return Number(result.lastInsertRowid)
}

function seedInjection(sessionId: number | null, host: string, hostSessionId: string, ids: number[]): void {
  temp.store.db
    .query(
      `INSERT INTO injections (session_id, host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at)
       VALUES (?, ?, ?, 'org/repo', ?, 'session_start', 100, ?)`,
    )
    .run(sessionId, host, hostSessionId, JSON.stringify(ids), T0)
}

const LIVE_KNOWN = 'shared-agent-memory test suite: 197 tests passing across 16 files'
const LIVE_ECHO = 'Test suite passes: 197 tests across 16 files'
const LIVE_PROJECT = '/Users/dev/Dev/rea/shared-agent-memory'

const event = (eventId: string, kind: string, tool?: Record<string, unknown>): ObserverEvent => ({
  eventId,
  sessionId: 1,
  promptNumber: 1,
  kind,
  toolName: typeof tool?.name === 'string' ? tool.name : null,
  payload: JSON.stringify({ kind, ...(tool !== undefined ? { tool } : {}) }),
  withheld: null,
  occurredAt: T0,
})
const BATCH = [event('reply', 'turn_end'), event('bun-test', 'tool_result', { name: 'Bash', output: '197 pass', exitCode: 0 })]

const proposed = (title: string, strength: ParsedObservation['evidence']['strength'], ids: string[]): ParsedObservation => ({
  type: 'discovery', title, narrative: '', facts: [], files: [], evidence: { strength, sourceEventIds: ids }, relations: [],
})

test('a SessionStart injection matches on host and host session id; other sessions do not leak in', () => {
  const session = seedSession(temp.store, 'claude-code', 'host-s1')
  const other = seedSession(temp.store, 'opencode', 'host-s2')
  const a = seedObservation(session, 'Adapter tests pass')
  const b = seedObservation(session, 'Spool drains in order')
  const c = seedObservation(other, 'Unrelated fact')
  seedInjection(null, 'claude-code', 'host-s1', [a, b])
  seedInjection(session, 'claude-code', 'host-s1', [b])
  seedInjection(other, 'opencode', 'host-s2', [c])

  expect(injectedObservations(temp.store.db, session)).toEqual([
    { id: a, title: 'Adapter tests pass', projectKey: PROJECT },
    { id: b, title: 'Spool drains in order', projectKey: PROJECT },
  ])
})

test('a session with no injection knows nothing', () => {
  expect(injectedObservations(temp.store.db, seedSession(temp.store, 'claude-code', 'fresh'))).toEqual([])
})

test('the live echo is dropped when it is only an interpretation', () => {
  const echo = proposed(LIVE_ECHO, 'interpretation', ['reply'])
  expect(dropEchoes([echo], [{ id: 3, title: LIVE_KNOWN, projectKey: LIVE_PROJECT }], BATCH, LIVE_PROJECT)).toEqual({ kept: [], echoes: 1 })
})

test('a tool-verified restatement and an unrelated interpretation are kept', () => {
  const confirmed = proposed(LIVE_ECHO, 'tool-verified', ['bun-test'])
  const fresh = proposed('Observer prompt now lists injected memory', 'interpretation', ['reply'])
  const result = dropEchoes([confirmed, fresh], [{ id: 3, title: LIVE_KNOWN, projectKey: LIVE_PROJECT }], BATCH, LIVE_PROJECT)
  expect(result).toEqual({ kept: [confirmed, fresh], echoes: 0 })
})

test('a proposed tool-verified label that the evidence rule downgrades counts as an interpretation', () => {
  const unbacked = proposed(LIVE_ECHO, 'tool-verified', ['reply'])
  expect(dropEchoes([unbacked], [{ id: 3, title: LIVE_KNOWN, projectKey: LIVE_PROJECT }], BATCH, LIVE_PROJECT).echoes).toBe(1)
})

test('the prompt shows known memory as a separate data block only when there is some', () => {
  const withKnown = buildObserverPrompt(BATCH, undefined, [{ id: 3, title: LIVE_KNOWN, projectKey: LIVE_PROJECT }])
  expect(withKnown.user).toContain(BEGIN_KNOWN)
  expect(withKnown.user).toContain(`#3 ${LIVE_KNOWN}`)
  expect(withKnown.user).toContain('Do not restate them')
  expect(withKnown.eventIds).toEqual(['reply', 'bun-test'])
  expect(buildObserverPrompt(BATCH).user).not.toContain(BEGIN_KNOWN)
})

test('a batch drops the echo, keeps the new observation, and reports the echo count', async () => {
  const session = seedSession(temp.store, 'claude-code', 'host-s1')
  const known = seedObservation(session, 'Adapter tests pass')
  seedInjection(null, 'claude-code', 'host-s1', [known])
  seedEvent(temp.store, session, { kind: 'user_prompt', at: T0 + 1_000, promptNumber: 1, promptText: 'what do you remember?' })
  seedEvent(temp.store, session, { kind: 'turn_end', at: T0 + 2_000, promptNumber: 1, assistantText: 'adapter tests pass' })

  let seen: ObserverPrompt | null = null
  const reply = (prompt: ObserverPrompt): string => {
    seen = prompt
    return JSON.stringify({
      observations: [
        { type: 'discovery', title: 'Adapter tests pass.', narrative: '', facts: [], files: [], evidence: { strength: 'interpretation', sourceEventIds: [prompt.eventIds[1]] } },
        { type: 'decision', title: 'User asked what the agent remembers', narrative: '', facts: [], files: [], evidence: { strength: 'user-stated', sourceEventIds: [prompt.eventIds[0]] } },
      ],
      summary: null,
    })
  }
  const outcome = await processSessionBatch({ db: temp.store.db, runnerFor: () => fakeRunner([reply]), now: () => T0 + 200_000 }, session)

  expect(outcome).toMatchObject({ status: 'succeeded', echoes: 1, observations: 1 })
  expect(seen!.user).toContain(`#${known} Adapter tests pass`)
  const titles = temp.store.db.query('SELECT title FROM observations WHERE id != ? ORDER BY id').all(known) as { title: string }[]
  expect(titles.map((row) => row.title)).toEqual(['User asked what the agent remembers'])
})
