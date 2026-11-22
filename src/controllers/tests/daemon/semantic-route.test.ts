import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { PROJECT, T0, seedSession } from '../observer/test-support'
import { openStore } from '../store/db'
import { vectorCounts } from '../store/vector-store'
import { vec0FileName } from '../vectors/extension'
import { type FakeEmbedder, fakeEmbedder } from '../vectors/test-support'
import { type RunningDaemon, startDaemon } from './daemon'

let root: string
let dataDir: string
let daemon: RunningDaemon
let logs: string[]
let token: string
let embedder: FakeEmbedder

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-semroute-'))
  dataDir = join(root, 'data')
  const store = openStore(dataDir)
  const session = seedSession(store, 'claude-code', 's1')
  for (const title of ['Parser drops quotes', 'Spool keeps event time']) seedObservation(store, { sessionId: session, projectKey: PROJECT, host: 'claude-code', title, at: T0 })
  store.db.close()
  logs = []
  embedder = fakeEmbedder()
  daemon = startDaemon({
    dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line),
    vectors: { embedder, tickMs: 60_000 },
  })
  token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()
})
afterEach(async () => {
  await daemon.stop()
  rmSync(root, { recursive: true, force: true })
})

const post = (body: unknown, auth: string | null = `Bearer ${token}`): Promise<Response> =>
  fetch(`http://127.0.0.1:${daemon.port}/search/semantic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth === null ? {} : { authorization: auth }) },
    body: JSON.stringify(body),
  })

test('the route takes the token only, and rejects a bad body with 400', async () => {
  expect((await post({ query: 'x', project: null, k: 3 }, null)).status).toBe(401)
  expect((await post({ query: 'x', project: null, k: 3 }, 'Bearer wrong')).status).toBe(401)
  const bad = await post({ query: '', project: null, k: 3 })
  expect(bad.status).toBe(400)
})

test('without sqlite-vec the answer is unavailable with the loader reason; the query is never logged', async () => {
  const member = vec0FileName(process.platform)!
  const response = await post({ query: 'SECRET-QUERY-TEXT', project: PROJECT, k: 3 })
  expect(await response.json()).toEqual({ status: 'unavailable', reason: expect.stringContaining(`${member} is missing; run kinfold install`) })
  expect(logs).toContain('semantic search status=unavailable')
  expect(logs.join('\n')).not.toContain('SECRET-QUERY-TEXT')
})

test('health says search is off, and the indexer still embeds the store at start', async () => {
  const health = await (await fetch(`http://127.0.0.1:${daemon.port}/health`)).json() as Record<string, unknown>
  expect(health.vectorSearch).toBe('off')
  await daemon.vectors!.whenIdle()
  expect(daemon.vectors!.status()).toMatchObject({ indexed: 2, pending: 0 })
  expect(logs.some((line) => line.startsWith('vectors search=off (') && line.includes(`${vec0FileName(process.platform)} is missing`))).toBe(true)
})

test('a daemon without vector options answers unavailable and embeds nothing', async () => {
  await daemon.stop()
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
  token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()
  expect(await (await post({ query: 'x', project: null, k: 3 })).json()).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('not configured') })
  expect(daemon.vectors).toBeNull()
  const store = openStore(dataDir)
  expect(vectorCounts(store.db, { model: 'other-model', dims: 8 }).pending).toBe(2)
  store.db.close()
})
