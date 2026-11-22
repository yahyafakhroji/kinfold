// A purge or a redaction says the data is gone and then scrubs the file. The
// sqlite-vec index holds a copy of each embedding, so its row must go in the
// same step, not when a later reconcile pass reaches it. Runs against the
// pinned sqlite-vec build named by KINFOLD_TEST_VEC0 and skips without it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readEnv } from '../env-names'
import { T0 } from '../observer/test-support'
import { insertFinding, listFindings } from '../store/findings-store'
import { startActive } from '../store/vector-spaces'
import type { Database } from '../sqlite/types'
import { dropIndexedVectors, upsertVectors } from '../store/vector-store'
import { createVecIndex } from '../vectors/vec-index'
import { reconcileVecIndex } from '../vectors/vec-index.test-support'
import { purge } from './purge'
import { resolveFinding } from './resolve'
import { DAY, type Fixture, seedFixture } from './test-support'

const VEC0 = readEnv(process.env, 'TEST_VEC0')

test('only a connection without sqlite-vec is let off: any other failure to clean an index stops the purge', () => {
  const failing = (message: string): Database => ({
    query: (sql: string) => (sql.startsWith('SELECT') ? { all: () => [{ name: 'vec_space_1' }] } : { run: () => { throw new Error(message) } }),
  }) as unknown as Database
  expect(() => dropIndexedVectors(failing('no such module: vec0'), [1])).not.toThrow()
  expect(() => dropIndexedVectors(failing('database is locked'), [1])).toThrow('database is locked')
})

describe.skipIf(VEC0 === undefined || VEC0 === '')('the sqlite-vec index after a purge or a redaction', () => {
  let fx: Fixture
  let space: { id: number; model: string; dims: number }
  beforeEach(() => {
    fx = seedFixture('kinfold-vec-purge-')
    fx.temp.store.db.loadExtension(VEC0!)
    space = startActive(db(), { model: 'm', dims: 4 }, T0)
    createVecIndex(db(), space)
    embed(fx.observations.a1, GONE)
    embed(fx.observations.a2, KEPT)
    expect(reconcileVecIndex(db(), space, 100).done).toBe(true)
    expect(indexed()).toEqual([fx.observations.a1, fx.observations.a2].sort((a, b) => a - b))
  })
  afterEach(() => fx.temp.cleanup())

  const db = () => fx.temp.store.db
  const GONE = Float32Array.from([0.123456, 0.654321, 0.111111, 0.999999])
  const KEPT = Float32Array.from([0.5, 0.25, 0.125, 0.0625])
  const hex = (vector: Float32Array): string => Buffer.from(vector.buffer).toString('hex').toUpperCase()
  const embed = (id: number, vector: Float32Array): void => {
    const hash = (db().query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
    upsertVectors(db(), space.model, [{ id, contentHash: hash, vector }], T0)
  }
  const indexed = (): number[] => db().query<{ id: number }, []>(`SELECT observation_id AS id FROM vec_space_${space.id} ORDER BY observation_id`).all().map((row) => row.id)
  /** Whether the index's own storage still holds these bytes. */
  const stored = (vector: Float32Array): boolean =>
    db().query<{ h: string }, []>(`SELECT hex(vectors) AS h FROM vec_space_${space.id}_vector_chunks00`).all().some((row) => row.h.includes(hex(vector)))

  test('a purged observation leaves the index, and its bytes leave the index storage, before the purge returns', () => {
    expect(stored(GONE)).toBe(true)
    const report = purge(db(), { kind: 'observation', id: fx.observations.a1 }, { dryRun: false, now: () => T0 + 10 * DAY })
    expect(report.counts.observations).toBe(1)
    expect(indexed()).toEqual([fx.observations.a2])
    expect(stored(GONE)).toBe(false)
    expect(stored(KEPT)).toBe(true)
  })

  test('a dry run takes nothing out of the index', () => {
    purge(db(), { kind: 'observation', id: fx.observations.a1 }, { dryRun: true, now: () => T0 + 10 * DAY })
    expect(indexed()).toHaveLength(2)
  })

  test('a redacted observation leaves the index with its old embedding', () => {
    insertFinding(db(), { table: 'observations', rowId: String(fx.observations.a1), field: 'title', rule: 'github_token', ruleVersion: 1, matches: 1, foundAt: T0 })
    const finding = listFindings(db(), { action: 'pending', limit: 10 })[0]!
    expect(resolveFinding(db(), finding.id, 'redact', { hmacKey: 'k', now: () => T0 + DAY })).toMatchObject({ ok: true })
    expect(indexed()).toEqual([fx.observations.a2])
    expect(stored(GONE)).toBe(false)
  })
})
