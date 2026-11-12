import { afterEach, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { seedObservation } from '../context/test-support'
import { readEnv } from '../env-names'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { NO_FILTERS, nearestObservations, upsertVectors } from '../store/vector-store'
import { upsertProject } from '../store/writes'
import { loadVec0, vec0Path } from './extension'
import { SPACE_IDS_SQL, type SpaceCache, cachedNearest, candidateIds, loadSpaceCache, pruneCache, refreshCacheRows } from './vector-cache'

const VEC0 = readEnv(process.env, 'TEST_VEC0')
const DIMS = 8

let temp: TempStore
let session: number
beforeEach(() => {
  temp = openTempStore('sam-vector-cache-')
  upsertProject(temp.store.db, { key: 'b', kind: 'git-remote', displayName: 'b' }, T0)
  session = seedSession(temp.store, 'claude-code', 's1')
})
afterEach(() => temp.cleanup())

/** A repeatable pseudo-random vector for row n. */
const vectorFor = (n: number, dims = DIMS): Float32Array => Float32Array.from({ length: dims }, (_, j) => Math.sin(n * 7.13 + j * 1.7) + (j === n % dims ? 0.8 : 0))

function seedVectors(count: number, model = 'm', dims = DIMS): number[] {
  const ids = Array.from({ length: count }, (_, n) =>
    seedObservation(temp.store, { sessionId: session, projectKey: n % 3 === 0 ? 'b' : PROJECT, host: 'claude-code', title: `${model} row ${n}`, at: T0 + n }))
  const hash = (id: number) => (temp.store.db.query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
  upsertVectors(temp.store.db, model, ids.map((id, n) => ({ id, contentHash: hash(id), vector: vectorFor(n + 1, dims) })), T0)
  return ids
}

const cosineDistance = (a: Float32Array, b: Float32Array): number => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let j = 0; j < a.length; j += 1) {
    dot += a[j]! * b[j]!
    na += a[j]! * a[j]!
    nb += b[j]! * b[j]!
  }
  return 1 - dot / Math.sqrt(na * nb)
}

test('the cache holds one model and length, with each row as a 16-bit vector and its project', () => {
  const ids = seedVectors(9)
  seedVectors(3, 'other')
  const cache = loadSpaceCache(temp.store.db, { model: 'm', dims: DIMS })
  expect(cache.rows.map((row) => row.id).sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b))
  expect(cache.rows[0]!.vector).toBeInstanceOf(Float16Array)
  expect(new Set(cache.rows.map((row) => row.project))).toEqual(new Set(['b', PROJECT]))
})

test('candidates are the nearest by cosine distance, within the project, at most n', () => {
  const ids = seedVectors(30)
  const cache = loadSpaceCache(temp.store.db, { model: 'm', dims: DIMS })
  const query = vectorFor(4)
  const expected = (project: string | null, n: number) =>
    ids.map((id, index) => ({ id, project: index % 3 === 0 ? 'b' : PROJECT, d: cosineDistance(query, vectorFor(index + 1)) }))
      .filter((row) => project === null || row.project === project)
      .sort((x, y) => x.d - y.d || y.id - x.id).slice(0, n).map((row) => row.id)
  expect(candidateIds(cache, query, null, 5)).toEqual(expected(null, 5))
  expect(candidateIds(cache, query, 'b', 4)).toEqual(expected('b', 4))
  expect(candidateIds(cache, query, 'nowhere', 4)).toEqual([])
})

test('a zero-length stored vector never ranks', () => {
  const [id] = seedVectors(1)
  const cache: SpaceCache = { model: 'm', dims: 2, rows: [{ id: id!, project: PROJECT, vector: new Float16Array(2), norm: 0 }], index: new Map([[id!, 0]]) }
  expect(candidateIds(cache, Float32Array.from([1, 0]), null, 5)).toEqual([])
})

test('refreshing rows picks up a new or re-embedded vector and drops a deleted one', () => {
  const ids = seedVectors(5)
  const cache = loadSpaceCache(temp.store.db, { model: 'm', dims: DIMS })
  const hash = (id: number) => (temp.store.db.query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
  upsertVectors(temp.store.db, 'm', [{ id: ids[0]!, contentHash: hash(ids[0]!), vector: vectorFor(99) }], T0 + 10)
  temp.store.db.run(`DELETE FROM observations WHERE id = ${ids[1]}`)
  const added = seedObservation(temp.store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title: 'late', at: T0 + 50 })
  upsertVectors(temp.store.db, 'm', [{ id: added, contentHash: hash(added), vector: vectorFor(42) }], T0 + 10)
  refreshCacheRows(temp.store.db, cache, [ids[0]!, ids[1]!, added])
  expect(cache.rows.map((row) => row.id).sort((a, b) => a - b)).toEqual([ids[0]!, ids[2]!, ids[3]!, ids[4]!, added].sort((a, b) => a - b))
  const first = cache.rows[cache.index.get(ids[0]!)!]!
  expect(Math.abs(first.vector[0]! - vectorFor(99)[0]!)).toBeLessThan(0.01)
  for (const [id, at] of cache.index) expect(cache.rows[at]!.id).toBe(id)
})

test('pruning drops rows gone from the store and reads only the covering index', () => {
  const ids = seedVectors(6)
  const cache = loadSpaceCache(temp.store.db, { model: 'm', dims: DIMS })
  for (const id of ids.slice(0, 2)) temp.store.db.run(`DELETE FROM observations WHERE id = ${id}`)
  pruneCache(temp.store.db, cache)
  expect(cache.rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(ids.slice(2).sort((a, b) => a - b))
  for (const [id, at] of cache.index) expect(cache.rows[at]!.id).toBe(id)
  const plan = (temp.store.db.query(`EXPLAIN QUERY PLAN ${SPACE_IDS_SQL}`).all({ model: 'm', dims: DIMS }) as { detail: string }[]).map((row) => row.detail)
  expect(plan).toEqual([expect.stringContaining('COVERING INDEX observation_vectors_by_space')])
})

test.skipIf(VEC0 === undefined || VEC0 === '')('cached search answers exactly as the SQL scan, also for rows deleted after the cache loaded', () => {
  mkdirSync(dirname(vec0Path(temp.dataDir)), { recursive: true })
  copyFileSync(VEC0!, vec0Path(temp.dataDir))
  expect(loadVec0(temp.store.db, temp.dataDir).ok).toBe(true)
  const ids = seedVectors(120)
  seedVectors(10, 'other')
  const cache = loadSpaceCache(temp.store.db, { model: 'm', dims: DIMS })
  const check = () => {
    for (const [n, k, project] of [[3, 10, null], [17, 1, 'b'], [50, 25, PROJECT], [77, 100, null]] as const) {
      const query = { model: 'm', vector: vectorFor(n), project, k, filters: NO_FILTERS }
      expect(cachedNearest(temp.store.db, cache, query)).toEqual(nearestObservations(temp.store.db, query))
    }
  }
  check()
  for (const id of ids.slice(0, 40)) temp.store.db.run(`DELETE FROM observations WHERE id = ${id}`)
  check()
})
