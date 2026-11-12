import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { readEnv } from '../env-names'
import { T0, seedSession } from '../observer/test-support'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { openStore } from '../store/db'
import { NO_FILTERS, nearestObservations, upsertVectors } from '../store/vector-store'
import { upsertProject } from '../store/writes'
import { loadVec0, vec0Path } from './extension'
import { type VectorQueries, startVectorWorker } from './vector-worker'

const FAKE = new URL('../../test/fake-search-worker.ts', import.meta.url).href
const VEC0 = readEnv(process.env, 'TEST_VEC0')

let opened: VectorQueries[] = []
const roots: string[] = []
afterEach(() => {
  for (const queries of opened) queries.close()
  opened = []
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fake(mode: string, limitMs = 2_000): Promise<VectorQueries> {
  const started = await startVectorWorker({ dbPath: mode, dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE, limitMs })
  if (!started.ok) throw new Error(started.reason)
  opened.push(started.queries)
  return started.queries
}

const NEAREST = { model: 'm', vector: Float32Array.from([1, 0]), project: null, k: 7, filters: NO_FILTERS }

test('a worker that cannot open the store reports why, and no queries are handed out', async () => {
  expect(await startVectorWorker({ dbPath: 'fail-start', dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE })).toEqual({
    ok: false, reason: 'cannot open the store',
  })
})

test('nearest and distances answer through the worker, matched to their request', async () => {
  const queries = await fake('ok')
  const [nearest, distances] = await Promise.all([
    queries.nearest(NEAREST),
    queries.distances({ model: 'm', vector: NEAREST.vector, project: 'a', ids: [42, 43] }),
  ])
  expect(nearest).toEqual([{ id: 7, distance: 0.25 }])
  expect(distances).toEqual([{ id: 42, distance: 0.25 }])
})

test('a read past its limit answers null while the main thread keeps running', async () => {
  const queries = await fake('slow', 100)
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 10)
  try {
    expect(await queries.nearest(NEAREST)).toBeNull()
  } finally {
    clearInterval(timer)
  }
  expect(ticks).toBeGreaterThan(3)
})

test('a worker that stops fails its query and every later one with a reason', async () => {
  const queries = await fake('crash')
  await expect(queries.nearest(NEAREST)).rejects.toThrow('the search worker stopped')
  await expect(queries.nearest(NEAREST)).rejects.toThrow('the search worker stopped')
})

test('closing fails a query still in flight instead of leaving it hanging', async () => {
  const queries = await fake('slow')
  const inFlight = queries.nearest(NEAREST)
  queries.close()
  await expect(inFlight).rejects.toThrow('the search worker was closed')
})

test.skipIf(VEC0 === undefined || VEC0 === '')('the real worker returns the same hits as the same search on the daemon connection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sam-vector-worker-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  const store = openStore(dataDir)
  try {
    mkdirSync(dirname(vec0Path(dataDir)), { recursive: true })
    copyFileSync(VEC0!, vec0Path(dataDir))
    expect(loadVec0(store.db, dataDir).ok).toBe(true)
    upsertProject(store.db, { key: 'b', kind: 'git-remote', displayName: 'b' }, T0)
    const session = seedSession(store, 'claude-code', 's1')
    const ids = ['east', 'north', 'west'].map((title) => seedObservation(store, { sessionId: session, projectKey: 'b', host: 'claude-code', title, at: T0 }))
    const hash = (id: number) => (store.db.query('SELECT content_hash AS h FROM observations WHERE id = ?').get(id) as { h: string }).h
    const points: [number, number][] = [[1, 0], [0, 1], [-1, 0]]
    upsertVectors(store.db, 'm', ids.map((id, index) => ({ id, contentHash: hash(id), vector: Float32Array.from(points[index]!) })), T0)

    const started = await startVectorWorker({ dbPath: store.path, dataDir, key: null, libraryOverride: process.env[SQLITE3MC_LIB_ENV] ?? null, cacheKib: 1_024 })
    if (!started.ok) throw new Error(started.reason)
    opened.push(started.queries)
    const query = { ...NEAREST, vector: Float32Array.from([1, 0.1]), project: 'b', k: 10 }
    expect(await started.queries.nearest(query)).toEqual(nearestObservations(store.db, query))
  } finally {
    store.db.close()
  }
})
