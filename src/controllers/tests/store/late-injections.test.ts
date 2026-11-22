// An answer that came after its host stopped waiting is stored with late = 1.
// It shows in watch and Sessions, marked; every reader that means "the agent
// got this memory" leaves it out; its duration still counts as latency.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedObservation } from '../../../resources/tests/context/test-support'
import { injectedObservations } from '../../../resources/observer/injected'
import { type TempStore, T0, openTempStore } from '../../../resources/tests/observer/test-support'
import { openTestDatabase } from '../../../resources/tests/sqlite/test-support'
import { watchRows } from '../../watch/reads'
import { recordInjection, sessionDeliveries } from '../../../resources/store/context-store'
import { contextCosts } from '../../../resources/store/impact-reads'
import { injectedIdsSince } from '../../../resources/store/mcp-read-store'
import { injectionDurations, injectionTotals } from '../../../resources/store/metrics-reads'
import { MIGRATIONS } from '../../../resources/store/schema'
import { sessionTurns } from '../../../resources/store/session-reads'
import { insertPrompt, upsertProject, upsertSession } from '../../../resources/store/writes'

const PROJECT = 'org/late'
let temp: TempStore
let session: number
let seen: number
let lateId: number

beforeEach(() => {
  temp = openTempStore('kinfold-late-')
  const db = temp.store.db
  upsertProject(db, { key: PROJECT, kind: 'path', displayName: 'late' }, T0)
  session = upsertSession(db, { host: 'claude-code', hostSessionId: 'cc', projectKey: PROJECT, cwd: '/w', occurredAt: T0 })
  const other = upsertSession(db, { host: 'opencode', hostSessionId: 'oc', projectKey: PROJECT, cwd: '/w', occurredAt: T0 - 100 })
  seen = seedObservation(temp.store, { sessionId: other, projectKey: PROJECT, host: 'opencode', title: 'shown in time', at: T0 - 10 })
  lateId = seedObservation(temp.store, { sessionId: other, projectKey: PROJECT, host: 'opencode', title: 'found too late', at: T0 - 5 })
  insertPrompt(db, { sessionId: session, promptNumber: 1, text: 'first', occurredAt: T0 + 1 })
  insertPrompt(db, { sessionId: session, promptNumber: 2, text: 'second', occurredAt: T0 + 2 })
  const row = { sessionId: session, host: 'claude-code', hostSessionId: 'cc', projectKey: PROJECT, channel: 'prompt' as const }
  recordInjection(db, { ...row, observationIds: [seen], tokens: 10, occurredAt: T0 + 1, durationMs: 50, promptNumber: 1 })
  recordInjection(db, { ...row, observationIds: [lateId], tokens: 30, occurredAt: T0 + 2, durationMs: 900, promptNumber: 2, late: true })
})
afterEach(() => temp.cleanup())

test('the delta, the observer, hit rate, context cost and totals leave a late row out', () => {
  const db = temp.store.db
  expect(sessionDeliveries(db, 'claude-code', 'cc').sentIds).toEqual([seen])
  expect(injectedObservations(db, session).map((row) => row.id)).toEqual([seen])
  expect(injectedIdsSince(db, 0).map((row) => row.observationIds)).toEqual([[seen]])
  expect(contextCosts(db, 0)).toMatchObject([{ host: 'claude-code', promptTokens: 10, tokens: 10 }])
  expect(injectionTotals(db)).toEqual([{ host: 'claude-code', channel: 'prompt', count: 1, tokens: 10 }])
})

test('its time still counts as latency: the agent waited for it', () => {
  expect(injectionDurations(temp.store.db, 0).map((row) => row.durationMs).sort((a, b) => a - b)).toEqual([50, 900])
})

test('watch and Sessions show it, marked late', () => {
  const db = temp.store.db
  const rows = watchRows(db, { afterId: 0, before: T0 + 10, host: null, project: null, limit: 10 })
  expect(rows.map((row) => row.late)).toEqual([false, true])
  expect(rows[1]!.line).toStartWith('kinfold · too late to show, not counted as sent · recalled 1')
  expect(rows[0]!.line).toStartWith('kinfold · recalled 1')
  const turns = sessionTurns(db, session, 0, 10)!.turns
  expect(turns.map((turn) => [turn.late, turn.recalled.map((entry) => entry.id)])).toEqual([[false, [seen]], [true, [lateId]]])
})

test('the read-only fallback can still read deliveries from a store from before v13', () => {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-late-v12-'))
  try {
    mkdirSync(root, { recursive: true })
    const db = openTestDatabase(join(root, 'memory.db'))
    for (const sql of MIGRATIONS.slice(0, 12)) db.run(sql)
    db.run(`INSERT INTO injections (host, host_session_id, project_key, observation_ids, channel, tokens, occurred_at)
      VALUES ('claude-code', 'cc', 'org/late', '[4]', 'session_start', 5, 1)`)
    expect(sessionDeliveries(db, 'claude-code', 'cc')).toEqual({ sentIds: [4], firstAt: 1 })
    db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('memory in one late answer is offered again; memory in two late answers counts as delivered, so it is not offered forever', () => {
  const db = temp.store.db
  const row = { sessionId: session, host: 'claude-code', hostSessionId: 'cc', projectKey: PROJECT, channel: 'prompt' as const, tokens: 30, durationMs: 900, late: true }
  expect(sessionDeliveries(db, 'claude-code', 'cc').sentIds).not.toContain(lateId)
  recordInjection(db, { ...row, observationIds: [lateId], occurredAt: T0 + 3, promptNumber: 3 })
  expect(sessionDeliveries(db, 'claude-code', 'cc').sentIds).toEqual([seen, lateId])
  // A session that only ever got late answers has not received memory: the delta keeps its floor at the session's start.
  expect(sessionDeliveries(db, 'claude-code', 'cc').firstAt).toBe(T0 + 1)
})
