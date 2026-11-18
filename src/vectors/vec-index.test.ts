// Runs against the pinned sqlite-vec build named by KINFOLD_TEST_VEC0 and
// skips without it, as the other vec0 tests do.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { readEnv } from '../env-names'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { startActive } from '../store/vector-spaces'
import { upsertVectors, dropVector } from '../store/vector-store'
import { upsertProject } from '../store/writes'
import { createVecIndex, dropVecIndex, dropVecIndexStep, knnCandidates, reconcileVecIndex, reconcileWindow, vecIndexExists, WINDOW_SQL, vecNearest, writeVecRows } from './vec-index'

const VEC0 = readEnv(process.env, 'TEST_VEC0')

describe.skipIf(VEC0 === undefined || VEC0 === '')('vec-index', () => {
  let temp: TempStore
  let session: number
  beforeEach(() => {
    temp = openTempStore('kinfold-vec-index-')
    temp.store.db.loadExtension(VEC0!)
    session = seedSession(temp.store, 'claude-code', 's1')
    upsertProject(temp.store.db, { key: 'other', kind: 'path', displayName: 'other' }, T0)
  })
  afterEach(() => temp.cleanup())

  const db = () => temp.store.db
  const SPACE = { model: 'm', dims: 2 }
  const hashOf = (id: number): string => (db().query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
  const seed = (title: string, x: number, y: number, project = PROJECT): number => {
    const id = seedObservation(temp.store, { sessionId: session, projectKey: project, host: 'claude-code', title, at: T0 })
    upsertVectors(db(), SPACE.model, [{ id, contentHash: hashOf(id), vector: Float32Array.from([x, y]) }], T0)
    return id
  }

  test('reconcile copies every vector in, in chunks, and reports when it is done', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const ids = [seed('a', 1, 0), seed('b', 0, 1), seed('c', 1, 1)]
    expect(reconcileVecIndex(db(), space, 2)).toEqual({ added: 2, removed: 0, done: false })
    expect(reconcileVecIndex(db(), space, 2)).toEqual({ added: 1, removed: 0, done: true })
    expect(knnCandidates(db(), space, Float32Array.from([1, 0]), null, 10).sort()).toEqual(ids.sort())
  })

  test('reconcile removes rows whose vector is gone', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const id = seed('a', 1, 0)
    seed('b', 0, 1)
    reconcileVecIndex(db(), space, 100)
    dropVector(db(), id)
    expect(reconcileVecIndex(db(), space, 100)).toEqual({ added: 0, removed: 1, done: true })
    expect(knnCandidates(db(), space, Float32Array.from([1, 0]), null, 10)).not.toContain(id)
  })

  test('reconcile files a row again when its observation moved to another project', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const id = seed('a', 1, 0)
    reconcileVecIndex(db(), space, 100)
    // As a project merge does on a connection without sqlite-vec: the row moves, its index row stays behind.
    db().query('UPDATE observations SET project_key = ? WHERE id = ?').run('other', id)
    expect(reconcileVecIndex(db(), space, 100)).toEqual({ added: 1, removed: 1, done: true })
    expect(knnCandidates(db(), space, Float32Array.from([1, 0]), 'other', 10)).toEqual([id])
  })

  test('candidates come nearest first and a project keeps to its own rows', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const east = seed('east', 1, 0)
    const north = seed('north', 0, 1)
    const elsewhere = seed('east elsewhere', 1, 0.01, 'other')
    reconcileVecIndex(db(), space, 100)
    expect(knnCandidates(db(), space, Float32Array.from([1, 0]), PROJECT, 10)).toEqual([east, north])
    expect(knnCandidates(db(), space, Float32Array.from([1, 0]), null, 2)).toEqual([east, elsewhere])
  })

  test('a write replaces the row of the same observation', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const id = seed('a', 1, 0)
    seed('b', 0, 1)
    writeVecRows(db(), space, [{ id, project: PROJECT, vector: Float32Array.from([1, 0]) }])
    writeVecRows(db(), space, [{ id, project: PROJECT, vector: Float32Array.from([0, -1]) }])
    expect(knnCandidates(db(), space, Float32Array.from([0, -1]), null, 1)).toEqual([id])
  })

  test('vecNearest takes exact distances from the store and applies the filters', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const east = seed('east', 1, 0)
    const north = seed('north', 0, 1)
    reconcileVecIndex(db(), space, 100)
    const hits = vecNearest(db(), space, { model: 'm', vector: Float32Array.from([1, 0]), project: PROJECT, k: 1 })
    expect(hits).toEqual([{ id: east, distance: 0 }])
    db().query("UPDATE observations SET type = 'decision' WHERE id = ?").run(north)
    const filtered = vecNearest(db(), space, { model: 'm', vector: Float32Array.from([1, 0]), project: PROJECT, k: 5, filters: { type: 'decision', host: null, evidence: null } })
    expect(filtered.map((hit) => hit.id)).toEqual([north])
    expect(filtered[0]!.distance).toBeCloseTo(1, 5)
  })

  test('a stale index row never outranks the stored vector', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const id = seed('a', 1, 0)
    reconcileVecIndex(db(), space, 100)
    // The store now says (0, 1); the index still says (1, 0).
    upsertVectors(db(), 'm', [{ id, contentHash: hashOf(id), vector: Float32Array.from([0, 1]) }], T0 + 1)
    const [hit] = vecNearest(db(), space, { model: 'm', vector: Float32Array.from([1, 0]), project: null, k: 1 })
    expect(hit!.distance).toBeCloseTo(1, 5)
  })

  test('when stale index rows crowd out live ones, the search scans instead', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const ids = Array.from({ length: 70 }, (_, i) => seed(`n${i}`, 1, i / 1000))
    const far = seed('far', 0, 1)
    reconcileVecIndex(db(), space, 100)
    for (const id of ids) db().query('DELETE FROM observations WHERE id = ?').run(id)
    expect(vecNearest(db(), space, { model: 'm', vector: Float32Array.from([1, 0]), project: null, k: 1 }).map((hit) => hit.id)).toEqual([far])
  })

  const indexedIds = (space: { id: number }): number[] =>
    (db().query(`SELECT rowid AS id FROM vec_space_${space.id}_rowids ORDER BY rowid`).all() as { id: number }[]).map((row) => row.id)

  test('a window reconciles only its own ids, and a pass ends past the largest id', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const ids = [seed('a', 1, 0), seed('b', 0, 1), seed('c', 1, 1), seed('d', 1, 2)]
    const first = reconcileWindow(db(), space, 0, { window: ids[2]!, limit: 100 })
    expect(first).toEqual({ added: 2, removed: 0, next: ids[2]!, end: false })
    expect(indexedIds(space)).toEqual(ids.slice(0, 2))
    const rest = reconcileWindow(db(), space, first.next, { window: 1_000, limit: 100 })
    expect(rest).toEqual({ added: 2, removed: 0, next: first.next + 1_000, end: true })
    expect(indexedIds(space)).toEqual(ids)
  })

  test('a window stops at its insert limit and resumes after the last id it wrote', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const ids = [seed('a', 1, 0), seed('b', 0, 1), seed('c', 1, 1)]
    const capped = reconcileWindow(db(), space, 0, { window: 1_000, limit: 2 })
    expect(capped).toEqual({ added: 2, removed: 0, next: ids[1]! + 1, end: false })
    expect(reconcileWindow(db(), space, capped.next, { window: 1_000, limit: 2 })).toMatchObject({ added: 1, end: true })
    expect(indexedIds(space)).toEqual(ids)
  })

  test('a window removes index rows with no stored vector and files moved rows under their new project', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const gone = seed('a', 1, 0)
    const moved = seed('b', 0, 1)
    reconcileWindow(db(), space, 0, { window: 1_000, limit: 100 })
    dropVector(db(), gone)
    db().query('UPDATE observations SET project_key = ? WHERE id = ?').run('other', moved)
    expect(reconcileWindow(db(), space, 0, { window: 1_000, limit: 100 })).toMatchObject({ added: 1, removed: 2, end: true })
    expect(indexedIds(space)).toEqual([moved])
    expect(knnCandidates(db(), space, Float32Array.from([0, 1]), 'other', 10)).toEqual([moved])
    // An index row past every stored vector (the newest observation purged) still goes.
    const last = seed('c', 1, 1)
    reconcileWindow(db(), space, 0, { window: 1_000, limit: 100 })
    db().query('DELETE FROM observations WHERE id = ?').run(last)
    expect(reconcileWindow(db(), space, 0, { window: 1_000, limit: 100 })).toMatchObject({ removed: 1, end: true })
    expect(indexedIds(space)).toEqual([moved])
  })

  test('a window reads index ranges only, never a scan of the vec0 table or the observations', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    const params = { model: 'm', dims: 2, from: 0, to: 2_000, ids: '[1,2]' }
    const plan = (sql: string, keys: readonly (keyof typeof params)[]): string[] =>
      (db().query(`EXPLAIN QUERY PLAN ${sql}`).all(Object.fromEntries(keys.map((key) => [key, params[key]]))) as { detail: string }[]).map((row) => row.detail)
    const details = [
      ...plan(WINDOW_SQL.stored, ['model', 'dims', 'from', 'to']),
      ...plan(WINDOW_SQL.projects, ['from', 'to']),
      ...plan(WINDOW_SQL.indexed(`vec_space_${space.id}`), ['from', 'to']),
      ...plan(WINDOW_SQL.vectors, ['model', 'dims', 'ids']),
    ]
    expect(details.filter((detail) => detail.startsWith('SCAN') && !detail.includes('json_each'))).toEqual([])
    expect(details.some((detail) => detail.includes('COVERING INDEX observations_recall'))).toBe(true)
  })

  test('a dropped index goes a vector chunk at a time, then the table', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    // Two partitions make two chunks.
    seed('a', 1, 0)
    seed('b', 0, 1, 'other')
    reconcileWindow(db(), space, 0, { window: 1_000, limit: 100 })
    expect(dropVecIndexStep(db(), space, 1)).toBe(false)
    expect(vecIndexExists(db(), space)).toBe(true)
    expect(dropVecIndexStep(db(), space, 1)).toBe(false)
    expect(dropVecIndexStep(db(), space, 1)).toBe(true)
    expect(vecIndexExists(db(), space)).toBe(false)
    expect(dropVecIndexStep(db(), space, 1)).toBe(true)
  })

  test('drop removes the table', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    expect(vecIndexExists(db(), space)).toBe(true)
    dropVecIndex(db(), space)
    expect(vecIndexExists(db(), space)).toBe(false)
  })
})
