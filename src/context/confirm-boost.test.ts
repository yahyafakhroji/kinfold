import { afterEach, beforeEach, expect, test } from 'bun:test'
import { purge } from '../data-control/purge'
import { type TempStore, PROJECT, T0, openTempStore, seedSession } from '../observer/test-support'
import { packObservations, readPack } from '../store/context-store'
import { confirmBoost, insertLinks, settleContradictions } from '../store/observation-links'
import { writeSharedSummary } from '../store/summary-share'
import { insertPrompt } from '../store/writes'
import { buildDelta, deltaOrder } from './delta'
import { compareStrength, rankScore } from './merge'
import { buildPack } from './pack'
import { rebuildProjectPacks } from './packs'
import { seedObservation } from './test-support'
import type { PackObservation } from './types'

// Confirmation boost (P1-I): +0.3 per current confirmer, capped at 3 (0.9),
// added to the evidence tier (tool-verified 3, user-stated 2, interpretation 1).

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-boost-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
})
afterEach(() => temp.cleanup())

const NOW = T0 + 3_600_000
const seed = (title: string, evidence: PackObservation['evidence'], at: number) =>
  seedObservation(temp.store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title, evidence, at })
const confirm = (from: number, to: number) => insertLinks(temp.store.db, from, [{ kind: 'confirms', observationId: to }], NOW)
const packIds = () => buildPack({ projectName: 'repo', observations: packObservations(temp.store.db, PROJECT, 200), nextSteps: null, budgetTokens: 2000, now: NOW }).observationIds
const row = (id: number, evidence: PackObservation['evidence'], occurredAt: number, confirmedBy = 0): PackObservation =>
  ({ id, host: 'h', title: `t${id}`, evidence, contradictedBy: null, contradictionKind: null, occurredAt, confirmedBy })

test('the boost is 0.3 per confirmer, capped at 0.9, and never crosses an evidence tier', () => {
  expect([0, 1, 2, 3, 7].map(confirmBoost)).toEqual([0, 0.3, 0.6, 0.8999999999999999, 0.8999999999999999])
  expect(rankScore(row(1, 'interpretation', 0, 9))).toBeLessThan(rankScore(row(2, 'user-stated', 0)))
  expect([row(1, 'interpretation', 5), row(2, 'interpretation', 1, 1), row(3, 'tool-verified', 0)].sort(compareStrength).map((r) => r.id)).toEqual([3, 2, 1])
})

test('pack order: a confirmed interpretation moves above a newer unconfirmed one, not above tool-verified', () => {
  const older = seed('Parser drops quoted strings', 'interpretation', T0)
  const newer = seed('Spool keeps host event time', 'interpretation', T0 + 1_000)
  const verified = seed('Redaction rules version two', 'tool-verified', T0 - 1_000)
  const confirmer = seed('Quoted strings vanish in parser output', 'interpretation', T0 + 2_000)
  expect(packIds()).toEqual([verified, confirmer, newer, older])
  confirm(confirmer, older)
  expect(packIds()).toEqual([verified, older, confirmer, newer])
})

test('a purged or contradicted confirmer no longer counts', () => {
  const target = seed('Parser drops quoted strings', 'interpretation', T0)
  const newer = seed('Spool keeps host event time', 'interpretation', T0 + 1_000)
  const confirmer = seed('Quoted strings vanish in parser output', 'interpretation', T0 + 2_000)
  confirm(confirmer, target)
  const counts = () => Object.fromEntries(packObservations(temp.store.db, PROJECT, 10).map((r) => [r.id, r.confirmedBy]))
  expect(counts()[target]).toBe(1)

  const disproof = seed('Parser keeps quoted strings after all', 'tool-verified', T0 + 3_000)
  insertLinks(temp.store.db, disproof, [{ kind: 'contradicts', observationId: confirmer }], NOW)
  expect(settleContradictions(temp.store.db, [confirmer])).toBe(1)
  expect(counts()[target]).toBe(0)
  expect(packIds().indexOf(newer)).toBeLessThan(packIds().indexOf(target))

  const second = seed('Quoted strings missing again', 'interpretation', T0 + 4_000)
  confirm(second, target)
  expect(counts()[target]).toBe(1)
  purge(temp.store.db, { kind: 'observation', id: second }, { dryRun: false, now: () => NOW })
  expect(counts()[target]).toBe(0)
})

test('D2 holds: a confirmed but contradicted row keeps its label and sits under its contradictor; confirms hides nothing', () => {
  const target = seed('Parser drops quoted strings', 'interpretation', T0)
  const confirmer = seed('Quoted strings vanish in parser output', 'tool-verified', T0 + 1_000)
  confirm(confirmer, target)
  expect(temp.store.db.query('SELECT contradicted_by AS c FROM observations WHERE id = ?').get(target)).toEqual({ c: null })
  const fix = seed('Parser fixed: quoted strings kept', 'tool-verified', T0 + 2_000)
  insertLinks(temp.store.db, fix, [{ kind: 'updates', observationId: target }], NOW)
  settleContradictions(temp.store.db, [target])
  const built = buildPack({ projectName: 'repo', observations: packObservations(temp.store.db, PROJECT, 200), nextSteps: null, budgetTokens: 2000, now: NOW })
  const at = built.observationIds.indexOf(target)
  expect(built.observationIds[at - 1]).toBe(fix)
  expect(built.itemLines[at]).toContain(`(updated by #${fix})`)
})

test('delta order: more confirmed first when the cap cuts, newest first otherwise', () => {
  const rows = [row(3, 'interpretation', 30), row(2, 'interpretation', 20, 2), row(1, 'tool-verified', 10, 1)]
  expect(deltaOrder(rows).map((r) => r.id)).toEqual([2, 1, 3])
  expect(deltaOrder(rows.map((r) => ({ ...r, confirmedBy: 0 }))).map((r) => r.id)).toEqual([3, 2, 1])
  const full = buildDelta({ projectName: 'repo', observations: rows, budgetTokens: 300, now: 40 })
  expect(full.observationIds).toEqual([2, 1, 3])
  const single = buildDelta({ projectName: 'repo', observations: [rows[1]!], budgetTokens: 300, now: 40 })
  const cut = buildDelta({ projectName: 'repo', observations: rows, budgetTokens: Math.ceil(single.text.length / 4) + 1, now: 40 })
  expect(cut.observationIds).toEqual([2])
})

test('the pack shows a shared summary once, with its repeat count', () => {
  const other = seedSession(temp.store, 'opencode', 'oc-1')
  const notice = 'Coordinator notice: worker done.'
  insertPrompt(temp.store.db, { sessionId: session, promptNumber: 1, text: notice, occurredAt: T0 })
  insertPrompt(temp.store.db, { sessionId: other, promptNumber: 1, text: notice, occurredAt: T0 + 1 })
  insertPrompt(temp.store.db, { sessionId: other, promptNumber: 2, text: notice, occurredAt: T0 + 2 })
  const summary = { request: 'r', learned: 'l', completed: 'c', nextSteps: 'Read the worker report' }
  for (const [id, n] of [[session, 1], [other, 1], [other, 2]] as const) {
    writeSharedSummary(temp.store.db, { sessionId: id, projectKey: PROJECT, promptNumber: n, summary, occurredAt: T0 + n, now: T0 + n })
  }
  rebuildProjectPacks(temp.store.db, PROJECT, NOW)
  const body = readPack(temp.store.db, PROJECT, 'claude-code')!.body
  expect(body).toContain('Next steps from the latest session summary (prompt repeated ×3): Read the worker report')
  expect(body.split('Read the worker report')).toHaveLength(2)
})
