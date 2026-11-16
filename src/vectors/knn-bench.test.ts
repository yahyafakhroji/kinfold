// The benchmark the design asks for: a store seeded with 50,000 vectors of the
// local model's length, searched through the vec0 index and by the SQL scan it
// replaced. It prints both timings and holds the index to a generous ceiling,
// so a slow shared runner does not fail it but a return to a full scan would.
// Runs against the pinned sqlite-vec build (KINFOLD_TEST_VEC0) and skips
// without it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readEnv } from '../env-names'
import { PROJECT, T0, type TempStore, openTempStore, seedSession } from '../observer/test-support'
import { setVecReady, startActive } from '../store/vector-spaces'
import { encodeVector, nearestObservations } from '../store/vector-store'
import { upsertProject } from '../store/writes'
import { LOCAL_MODEL_DIMS, LOCAL_MODEL_ID } from './local-model'
import { createVecIndex, nearestFor, reconcileVecIndex } from './vec-index'

const VEC0 = readEnv(process.env, 'TEST_VEC0')
const BENCH_VECTORS = 50_000
const PROJECTS = 20
const RUNS = 15
/** p50 ceiling for one k-NN through the index on a shared CI runner. */
const INDEX_P50_CEILING_MS = 250

/** A fixed pseudo-random sequence, so every run seeds the same store. */
function generator(seed: number): () => number {
  let state = seed
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    return state / 2_147_483_648 - 0.5
  }
}

function vectorFrom(next: () => number): Float32Array {
  const vector = new Float32Array(LOCAL_MODEL_DIMS)
  for (let i = 0; i < vector.length; i += 1) vector[i] = next()
  return vector
}

function p50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

describe.skipIf(VEC0 === undefined || VEC0 === '')(`k-NN over ${BENCH_VECTORS} vectors`, () => {
  let temp: TempStore
  const next = generator(7)

  beforeAll(() => {
    temp = openTempStore('kinfold-knn-bench-')
    const db = temp.store.db
    db.loadExtension(VEC0!)
    const session = seedSession(temp.store, 'claude-code', 'bench')
    for (let p = 0; p < PROJECTS; p += 1) upsertProject(db, { key: `p${p}`, kind: 'path', displayName: `p${p}` }, T0)
    const observation = db.prepare(`INSERT INTO observations (id, project_key, session_id, host, prompt_number, type, title, narrative, facts, files, evidence,
      source_event_ids, observer_model, content_hash, occurred_at, created_at, rules_version, scanned_version)
      VALUES ($id, $project, $session, 'claude-code', 1, 'discovery', 't', '', '[]', '[]', 'tool-verified', '[]', 'bench', $hash, $at, $at, 1, 0)`)
    const vector = db.prepare('INSERT INTO observation_vectors (observation_id, model, dims, embedding, created_at) VALUES ($id, $model, $dims, $embedding, $at)')
    db.transaction(() => {
      for (let id = 1; id <= BENCH_VECTORS; id += 1) {
        observation.run({ id, project: id % PROJECTS === 0 ? PROJECT : `p${id % PROJECTS}`, session, hash: `h${id}`, at: T0 })
        vector.run({ id, model: LOCAL_MODEL_ID, dims: LOCAL_MODEL_DIMS, embedding: encodeVector(vectorFrom(next)), at: T0 })
      }
    })()
    const space = startActive(db, { model: LOCAL_MODEL_ID, dims: LOCAL_MODEL_DIMS }, T0)
    createVecIndex(db, space)
    reconcileVecIndex(db, space, BENCH_VECTORS)
    setVecReady(db, space.id, true)
  }, 180_000)
  afterAll(() => temp?.cleanup())

  test('the index answers in milliseconds and matches the scan', () => {
    const db = temp.store.db
    const time = (project: string | null, run: (query: Parameters<typeof nearestFor>[1]) => unknown): number[] => Array.from({ length: RUNS }, () => {
      const query = { model: LOCAL_MODEL_ID, vector: vectorFrom(next), project, k: 10 }
      const startedAt = performance.now()
      run(query)
      return performance.now() - startedAt
    })
    const indexAll = p50(time(null, (query) => nearestFor(db, query)))
    const indexProject = p50(time(PROJECT, (query) => nearestFor(db, query)))
    const scanAll = p50(time(null, (query) => nearestObservations(db, query)))
    const scanProject = p50(time(PROJECT, (query) => nearestObservations(db, query)))
    console.log(`knn-bench vectors=${BENCH_VECTORS} dims=${LOCAL_MODEL_DIMS} index_p50_ms=${indexAll.toFixed(1)} scan_p50_ms=${scanAll.toFixed(1)} `
      + `one_project index_p50_ms=${indexProject.toFixed(1)} scan_p50_ms=${scanProject.toFixed(1)}`)
    // Only a ceiling: on a warm plaintext store the scan is close, and CI runners vary.
    expect(indexAll).toBeLessThan(INDEX_P50_CEILING_MS)

    const query = { model: LOCAL_MODEL_ID, vector: vectorFrom(next), project: null, k: 10 }
    expect(nearestFor(db, query).map((hit) => hit.id)).toEqual(nearestObservations(db, query).map((hit) => hit.id))
  }, 120_000)
})
