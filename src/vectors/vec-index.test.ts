// Runs against the pinned sqlite-vec build named by KINFOLD_TEST_VEC0 and
// skips without it, as the other vec0 tests do.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { seedObservation } from '../context/test-support'
import { readEnv } from '../env-names'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { startActive } from '../store/vector-spaces'
import { upsertVectors, dropVector } from '../store/vector-store'
import { upsertProject } from '../store/writes'
import { createVecIndex, dropVecIndex, knnCandidates, reconcileVecIndex, vecIndexExists, vecNearest, writeVecRows } from './vec-index'

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

  test('drop removes the table', () => {
    const space = startActive(db(), SPACE, T0)
    createVecIndex(db(), space)
    expect(vecIndexExists(db(), space)).toBe(true)
    dropVecIndex(db(), space)
    expect(vecIndexExists(db(), space)).toBe(false)
  })
})
