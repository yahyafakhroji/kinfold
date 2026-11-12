import { afterEach, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { readEnv } from '../env-names'
import { T0, seedSession } from '../observer/test-support'
import { newDbKey } from '../sqlite/keys'
import { SQLITE3MC_LIB_ENV } from '../sqlite/library'
import { openStore } from '../store/db'
import { NO_FILTERS, type VectorHit, nearestObservations, upsertVectors } from '../store/vector-store'
import { upsertProject } from '../store/writes'
import { loadVec0, vec0Path } from './extension'
import { type VectorQueries, runNow, startVectorWorker, workerOrInline } from './vector-worker'

const FAKE = new URL('../../test/fake-search-worker.ts', import.meta.url).href
const VEC0 = readEnv(process.env, 'TEST_VEC0')

let opened: VectorQueries[] = []
const roots: string[] = []
afterEach(() => {
  for (const queries of opened) queries.close()
  opened = []
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const startFake = (mode: string, limitMs = 2_000) =>
  startVectorWorker({ dbPath: mode, dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE, limitMs })

async function fake(mode: string, limitMs = 2_000): Promise<VectorQueries> {
  const started = await startFake(mode, limitMs)
  if (!started.ok) throw new Error(started.reason)
  opened.push(started.queries)
  return started.queries
}

const NEAREST = { model: 'm', vector: Float32Array.from([1, 0]), project: null, k: 7, filters: NO_FILTERS }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a worker that cannot open the store reports why, and no queries are handed out', async () => {
  expect(await startFake('fail-start')).toEqual({ ok: false, reason: 'cannot open the store' })
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

test('the main thread keeps running while the worker scans, and a reply after the limit is ignored', async () => {
  const queries = await fake('busy', 100)
  let ticks = 0
  const timer = setInterval(() => { ticks += 1 }, 10)
  try {
    expect(await queries.nearest(NEAREST)).toBeNull()
    await sleep(300)
  } finally {
    clearInterval(timer)
  }
  expect(ticks).toBeGreaterThan(10)
  // The late reply settled nothing twice, and it marked the worker idle: exclusive work runs.
  expect(await queries.exclusive(() => 'ran')).toBe('ran')
})

test('a read with no time left answers null without reaching the worker', async () => {
  const queries = await fake('busy')
  const startedAt = performance.now()
  expect(await queries.nearest(NEAREST, 0)).toBeNull()
  expect(performance.now() - startedAt).toBeLessThan(50)
  expect(await queries.exclusive(() => 'idle')).toBe('idle')
})

test('exclusive work that throws still lets held reads through', async () => {
  const queries = await fake('ok')
  const failing = queries.exclusive(() => {
    throw new Error('purge failed')
  })
  const held = queries.nearest(NEAREST)
  await expect(failing).rejects.toThrow('purge failed')
  expect(await held).toEqual([{ id: 7, distance: 0.25 }])
})

test('a read whose caller gives up answers null then, and the worker drops it unread', async () => {
  const queries = await fake('busy')
  const first = queries.nearest(NEAREST)
  const startedAt = performance.now()
  const second = await queries.nearest({ ...NEAREST, k: 9 }, 50)
  expect(second).toBeNull()
  expect(performance.now() - startedAt).toBeLessThan(250)
  expect(await first).toEqual([{ id: 7, distance: 0.25 }])
})

test('exclusive work waits for the read in the worker, and new reads wait for the work', async () => {
  const queries = await fake('busy')
  const order: string[] = []
  const reading = queries.nearest(NEAREST).then(() => order.push('read'))
  const work = queries.exclusive(() => {
    order.push('work')
    return 'done'
  })
  const after = queries.nearest({ ...NEAREST, k: 8 }).then(() => order.push('later read'))
  expect(await work).toBe('done')
  await Promise.all([reading, after])
  expect(order).toEqual(['read', 'work', 'later read'])
})

test('with no read in flight, exclusive work runs at once', async () => {
  const queries = await fake('ok')
  let ran = false
  const done = queries.exclusive(() => {
    ran = true
  })
  await done
  expect(ran).toBe(true)
  let now = false
  void runNow(() => {
    now = true
  })
  expect(now).toBe(true)
})

test('a worker that stops fails its query and every later one with a reason', async () => {
  const queries = await fake('crash')
  await expect(queries.nearest(NEAREST)).rejects.toThrow('the search worker stopped')
  await expect(queries.nearest(NEAREST)).rejects.toThrow('the search worker stopped')
})

test('after a worker stops, searches move to the daemon connection and the move is logged once', async () => {
  const lines: string[] = []
  const inlineHits: VectorHit[] = [{ id: 1, distance: 0.5 }]
  const inline: VectorQueries = { nearest: async () => inlineHits, distances: async () => [], exclusive: runNow, close: () => {} }
  const queries = workerOrInline(startFake('crash'), inline, (line) => lines.push(line))
  opened.push(queries)
  expect(await queries.nearest(NEAREST)).toEqual(inlineHits)
  expect(await queries.nearest(NEAREST)).toEqual(inlineHits)
  expect(lines.filter((line) => line.includes('the search worker stopped'))).toHaveLength(1)
})

test('a worker that cannot start leaves searches on the daemon connection', async () => {
  const lines: string[] = []
  const inline: VectorQueries = { nearest: async () => [{ id: 2, distance: 0.1 }], distances: async () => [], exclusive: runNow, close: () => {} }
  const queries = workerOrInline(startFake('fail-start'), inline, (line) => lines.push(line))
  expect(await queries.nearest(NEAREST)).toEqual([{ id: 2, distance: 0.1 }])
  expect(lines).toEqual(['vectors search worker off (cannot open the store); searching on the daemon connection'])
})

test('closing fails a query still in flight instead of leaving it hanging', async () => {
  const queries = await fake('slow')
  const inFlight = queries.nearest(NEAREST)
  queries.close()
  await expect(inFlight).rejects.toThrow('the search worker was closed')
})

const vec0Ready = VEC0 !== undefined && VEC0 !== ''

for (const encrypted of [false, true]) {
  test.skipIf(!vec0Ready)(`the real worker returns the same hits as the daemon connection (${encrypted ? 'encrypted' : 'plaintext'} store)`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'sam-vector-worker-'))
    roots.push(root)
    const dataDir = join(root, 'data')
    const key = encrypted ? newDbKey() : null
    const keys = key === null ? undefined : { name: 'test keys', read: () => key, exists: () => true }
    const store = openStore(dataDir, keys === undefined ? {} : { keys })
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

      const started = await startVectorWorker({ dbPath: store.path, dataDir, key, libraryOverride: process.env[SQLITE3MC_LIB_ENV] ?? null, cacheKib: 1_024 })
      if (!started.ok) throw new Error(started.reason)
      opened.push(started.queries)
      const query = { ...NEAREST, vector: Float32Array.from([1, 0.1]), project: 'b', k: 10 }
      expect(await started.queries.nearest(query)).toEqual(nearestObservations(store.db, query))
    } finally {
      store.db.close()
    }
  })
}
