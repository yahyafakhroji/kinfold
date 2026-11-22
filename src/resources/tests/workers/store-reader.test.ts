import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { PROJECT, T0, seedSession } from '../observer/test-support'
import { newDbKey } from '../../sqlite/keys'
import { testLibraryPath } from '../sqlite/test-support'
import { openStore } from '../../store/db'
import { observationFacets } from '../../store/memory-reads'
import { ReadExpiredError, type StoreReader, inlineStoreReader, readerOrInline, startStoreReader } from '../../workers/store-reader'

const FAKE = new URL('../../../../test/fake-store-reader.ts', import.meta.url).href

let opened: StoreReader[] = []
const roots: string[] = []
afterEach(async () => {
  // A worker still holding memory.db keeps Windows from deleting the folder.
  await Promise.all(opened.map((reader) => reader.close()))
  opened = []
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempStore(key: string | null = null): { dataDir: string; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'kinfold-store-reader-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  const store = openStore(dataDir, key === null ? {} : { keys: { name: 'test', read: () => key, exists: () => true } })
  try {
    const sessionId = seedSession(store, 'claude-code', 's-1')
    seedObservation(store, { sessionId, projectKey: PROJECT, host: 'claude-code', title: 'Bun is pinned', at: T0 })
    return { dataDir, dbPath: store.path }
  } finally {
    store.db.close()
  }
}

async function started(options: Parameters<typeof startStoreReader>[0]): Promise<StoreReader> {
  const start = await startStoreReader(options)
  if (!start.ok) throw new Error(start.reason)
  opened.push(start.reader)
  return start.reader
}

const fake = (mode: string, limitMs = 2_000) => started({ dbPath: mode, dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE, limitMs })

test('a read through the worker answers as the same read on the daemon connection', async () => {
  const key = newDbKey()
  const { dataDir, dbPath } = tempStore(key)
  const reader = await started({ dbPath, dataDir, key, libraryOverride: testLibraryPath(), cacheKib: null })
  const store = openStore(dataDir, { keys: { name: 'test', read: () => key, exists: () => true } })
  try {
    expect(await reader.run('memoryFacets', {})).toEqual(observationFacets(store.db))
    expect(await inlineStoreReader(store.db, dbPath).run('memoryFacets', {})).toEqual(observationFacets(store.db))
  } finally {
    store.db.close()
  }
})

test('a worker that cannot open the store reports why', async () => {
  expect(await startStoreReader({ dbPath: 'fail-start', dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE })).toEqual({ ok: false, reason: 'cannot open the store' })
})

test('the main thread keeps running while the worker reads', async () => {
  const reader = await fake('busy')
  let ticks = 0
  const timer = setInterval(() => (ticks += 1), 10)
  try {
    expect(await reader.run('ping', { value: 3 })).toEqual({ value: 3 })
    expect(ticks).toBeGreaterThan(10)
  } finally {
    clearInterval(timer)
  }
})

test('a request still queued past its expiry is skipped, and its caller is told', async () => {
  const reader = await fake('busy')
  const first = reader.run('ping', { value: 1 })
  const second = reader.run('ping', { value: 2 }, { expireMs: 50 })
  expect(await first).toEqual({ value: 1 })
  // Awaited, not expect().rejects: that wait runs timers but not worker messages.
  expect(await second.catch((error: unknown) => error)).toBeInstanceOf(ReadExpiredError)
})

test('hold waits for reads in the worker and keeps new ones back until released', async () => {
  const reader = await fake('busy')
  const inFlight = reader.run('ping', { value: 1 })
  let held = false
  const release = await reader.hold().then((done) => {
    held = true
    return done
  })
  expect(held).toBe(true)
  expect(await inFlight).toEqual({ value: 1 })
  let answered = false
  const later = reader.run('ping', { value: 2 }).then((value) => {
    answered = true
    return value
  })
  await Bun.sleep(400)
  expect(answered).toBe(false)
  release()
  expect(await later).toEqual({ value: 2 })
})

test('reads go to the daemon connection while the worker starts, and after it stops', async () => {
  const { dataDir, dbPath } = tempStore()
  const store = openStore(dataDir)
  try {
    const inline = inlineStoreReader(store.db, dbPath)
    const logs: string[] = []
    let resolveStart: (value: Awaited<ReturnType<typeof startStoreReader>>) => void = () => {}
    const starting = new Promise<Awaited<ReturnType<typeof startStoreReader>>>((resolve) => (resolveStart = resolve))
    let starts = 0
    const reader = readerOrInline('recall', () => (starts += 1, starting), inline, (line) => logs.push(line))
    opened.push(reader)
    // A daemon that is never asked starts no worker.
    expect(starts).toBe(0)
    // Not started yet: answered at once from the daemon's own connection, and the worker is asked to start.
    expect(await reader.run('ping', { value: 1 })).toEqual({ value: 1 })
    expect(await reader.run('ping', { value: 1 })).toEqual({ value: 1 })
    expect(starts).toBe(1)
    const worker = await startStoreReader({ dbPath: 'crash', dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE })
    resolveStart(worker)
    await Bun.sleep(20)
    // The fake worker dies on its first request; the read falls back and the switch is logged once.
    expect(await reader.run('ping', { value: 2 })).toEqual({ value: 2 })
    expect(await reader.run('ping', { value: 3 })).toEqual({ value: 3 })
    expect(logs.filter((line) => line.includes('recall reader worker stopped'))).toHaveLength(1)
  } finally {
    store.db.close()
  }
})

test('a hold asked while the worker is starting covers the worker once it is up', async () => {
  const { dataDir, dbPath } = tempStore()
  const store = openStore(dataDir)
  try {
    const inline = inlineStoreReader(store.db, dbPath)
    const starting = Bun.sleep(50).then(() => startStoreReader({ dbPath: 'busy', dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE }))
    const reader = readerOrInline('recall', () => starting, inline, () => {})
    opened.push(reader)
    await reader.run('ping', { value: 1 })
    const release = await reader.hold()
    let answered = false
    const later = reader.run('ping', { value: 2 }).then((value) => {
      answered = true
      return value
    })
    await Bun.sleep(400)
    expect(answered).toBe(false)
    release()
    expect(await later).toEqual({ value: 2 })
  } finally {
    store.db.close()
  }
})

test('a reader that waits for its worker never reads on the daemon connection while the worker starts', async () => {
  const { dataDir, dbPath } = tempStore()
  const store = openStore(dataDir)
  try {
    const inline = inlineStoreReader(store.db, dbPath)
    let inlineReads = 0
    const counting = { ...inline, run: ((op, args, options) => (inlineReads += 1, inline.run(op, args, options))) as typeof inline.run }
    const starting = Bun.sleep(50).then(() => startStoreReader({ dbPath: 'ok', dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE }))
    const reader = readerOrInline('reports', () => starting, counting, () => {}, { waitForStart: true })
    opened.push(reader)
    expect(await reader.run('ping', { value: 1 })).toEqual({ value: 1 })
    expect(inlineReads).toBe(0)
  } finally {
    store.db.close()
  }
})

test('an eager reader starts its worker before any read, so the first prompt after a start is read there', async () => {
  const { dataDir, dbPath } = tempStore()
  const store = openStore(dataDir)
  try {
    const inline = inlineStoreReader(store.db, dbPath)
    let inlineReads = 0
    const counting = { ...inline, run: ((op, args, options) => (inlineReads += 1, inline.run(op, args, options))) as typeof inline.run }
    let starts = 0
    const reader = readerOrInline('recall', () => (starts += 1, startStoreReader({ dbPath: 'ok', dataDir: '/nowhere', key: null, libraryOverride: null, cacheKib: null, workerUrl: FAKE })), counting, () => {}, { eager: true })
    opened.push(reader)
    expect(starts).toBe(1)
    await Bun.sleep(200)
    expect(await reader.run('ping', { value: 1 })).toEqual({ value: 1 })
    expect(inlineReads).toBe(0)
  } finally {
    store.db.close()
  }
})
