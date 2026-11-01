import { afterEach, beforeEach, expect, test } from 'bun:test'
import { purge } from '../data-control/purge'
import type { EvidenceStrength } from '../evidence'
import { PROJECT, type TempStore, T0, openTempStore, seedSession } from '../observer/test-support'
import { EVIDENCE_STRENGTHS } from '../observer/types'
import { canOverturn, insertLinks, linkTargets, linksOf, settleContradictions } from './observation-links'
import { upsertProject } from './writes'

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-links-')
  session = seedSession(temp.store, 'claude-code', 's1')
})
afterEach(() => temp.cleanup())

function seed(title: string, evidence: EvidenceStrength, at: number, project: string = PROJECT): number {
  const result = temp.store.db.query(
    `INSERT INTO observations (project_key, session_id, host, type, title, evidence, content_hash, occurred_at, created_at)
     VALUES (?, ?, 'claude-code', 'discovery', ?, ?, ?, ?, ?)`,
  ).run(project, session, title, evidence, `hash-${title}`, at, at)
  return Number(result.lastInsertRowid)
}

const hiddenBy = (id: number): number | null =>
  (temp.store.db.query('SELECT contradicted_by AS by FROM observations WHERE id = ?').get(id) as { by: number | null }).by
const linkCount = (): number => (temp.store.db.query('SELECT count(*) AS n FROM observation_links').get() as { n: number }).n

function link(from: number, to: number, kind: 'confirms' | 'updates' | 'contradicts'): number {
  insertLinks(temp.store.db, from, [{ kind, observationId: to }], T0)
  return settleContradictions(temp.store.db, kind === 'confirms' ? [] : [to])
}

test('evidence rule: only an interpretation over a tool-verified or user-stated row is refused, in TS and in SQL alike', () => {
  for (const older of EVIDENCE_STRENGTHS) {
    for (const newer of EVIDENCE_STRENGTHS) {
      const oldId = seed(`old ${older} ${newer}`, older, T0)
      const newId = seed(`new ${older} ${newer}`, newer, T0 + 1)
      link(newId, oldId, 'contradicts')
      expect({ older, newer, hidden: hiddenBy(oldId) === newId }).toEqual({ older, newer, hidden: canOverturn(newer, older) })
    }
  }
  expect(canOverturn('interpretation', 'tool-verified')).toBe(false)
  expect(canOverturn('interpretation', 'user-stated')).toBe(false)
  expect(canOverturn('interpretation', 'interpretation')).toBe(true)
  expect(canOverturn('tool-verified', 'user-stated')).toBe(true)
})

test('a refused link is still recorded and the detail shows it as not applied', () => {
  const old = seed('route returns 3 matches', 'tool-verified', T0)
  const guess = seed('route returns nothing', 'interpretation', T0 + 1)
  expect(link(guess, old, 'contradicts')).toBe(0)
  expect(hiddenBy(old)).toBeNull()
  expect(linksOf(temp.store.db, old)).toEqual([
    { id: guess, title: 'route returns nothing', evidence: 'interpretation', kind: 'contradicts', direction: 'incoming', applied: false, current: true, createdAt: T0 },
  ])
})

test('updates and contradicts hide the older row once; confirms never hides; an already hidden row keeps its first link', () => {
  const old = seed('48 tests pass', 'interpretation', T0)
  const confirm = seed('48 tests pass again', 'tool-verified', T0 + 1)
  const update = seed('52 tests pass', 'tool-verified', T0 + 2)
  const later = seed('the suite is red', 'tool-verified', T0 + 3)
  expect(link(confirm, old, 'confirms')).toBe(0)
  expect(hiddenBy(old)).toBeNull()
  expect(link(update, old, 'updates')).toBe(1)
  expect(link(later, old, 'contradicts')).toBe(0)
  expect(hiddenBy(old)).toBe(update)
  expect(linksOf(temp.store.db, old).map((row) => [row.id, row.kind, row.direction, row.applied])).toEqual([
    [confirm, 'confirms', 'incoming', false],
    [update, 'updates', 'incoming', true],
    [later, 'contradicts', 'incoming', false],
  ])
  expect(linksOf(temp.store.db, update)).toEqual([expect.objectContaining({ id: old, kind: 'updates', direction: 'outgoing', applied: true })])
})

test('a link is idempotent, never self-referencing, never across projects, and never lets an older row hide a newer one', () => {
  upsertProject(temp.store.db, { key: 'other/repo', kind: 'git-remote', displayName: 'other' }, T0)
  const a = seed('a', 'tool-verified', T0)
  const b = seed('b', 'tool-verified', T0 + 1)
  const foreign = seed('foreign', 'tool-verified', T0 + 2, 'other/repo')
  expect(insertLinks(temp.store.db, b, [{ kind: 'contradicts', observationId: a }], T0)).toBe(1)
  expect(insertLinks(temp.store.db, b, [{ kind: 'contradicts', observationId: a }], T0 + 5)).toBe(0)
  expect(insertLinks(temp.store.db, a, [{ kind: 'contradicts', observationId: a }], T0)).toBe(0)
  expect(insertLinks(temp.store.db, foreign, [{ kind: 'contradicts', observationId: a }], T0)).toBe(0)
  expect(linkCount()).toBe(1)
  insertLinks(temp.store.db, a, [{ kind: 'contradicts', observationId: b }], T0)
  expect(settleContradictions(temp.store.db, [b])).toBe(0)
  expect(hiddenBy(b)).toBeNull()
})

test('purging the newer row shows the older one again and removes its links; the dry run counts them', () => {
  const old = seed('old', 'interpretation', T0)
  const newer = seed('newer', 'tool-verified', T0 + 1)
  link(newer, old, 'contradicts')
  expect(hiddenBy(old)).toBe(newer)
  expect(purge(temp.store.db, { kind: 'observation', id: newer }, { dryRun: true, now: () => T0 }).counts).toMatchObject({ observations: 1, links: 1 })
  expect(hiddenBy(old)).toBe(newer)
  const report = purge(temp.store.db, { kind: 'observation', id: newer }, { dryRun: false, now: () => T0 })
  expect(report.counts).toMatchObject({ observations: 1, links: 1 })
  expect(hiddenBy(old)).toBeNull()
  expect(linkCount()).toBe(0)
})

test('purging the hiding row hands the older one to the next link the rule allows', () => {
  const old = seed('old', 'interpretation', T0)
  const first = seed('first', 'tool-verified', T0 + 1)
  const second = seed('second', 'user-stated', T0 + 2)
  link(first, old, 'updates')
  link(second, old, 'contradicts')
  expect(linkTargets(temp.store.db, [first])).toEqual([old])
  purge(temp.store.db, { kind: 'observation', id: first }, { dryRun: false, now: () => T0 })
  expect(hiddenBy(old)).toBe(second)
})

test('purging the older row deletes its incoming links through the foreign key', () => {
  const old = seed('old', 'interpretation', T0)
  const newer = seed('newer', 'tool-verified', T0 + 1)
  link(newer, old, 'contradicts')
  purge(temp.store.db, { kind: 'observation', id: old }, { dryRun: false, now: () => T0 })
  expect(linkCount()).toBe(0)
  expect(linksOf(temp.store.db, newer)).toEqual([])
})
