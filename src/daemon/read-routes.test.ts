import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureEvent } from '../capture/capture'
import { type NormalizedEvent, SCHEMA_VERSION } from '../contract/event'
import { ulid } from '../contract/ulid'
import { createDashboardAuth, sessionCookie } from '../dashboard/auth'
import { type MemoryReader, openMemoryReader } from '../mcp/reader'
import { NOW, PROJECT_A, PROJECT_B, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import { callTool } from '../mcp/tools'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { loadHmacKey } from '../store/hmac-key'
import type { ProjectKey } from '../store/project-key'
import { startDaemon } from './daemon'
import { MAX_READ_CWD_CHARS, READ_TOOLS, type ReadTool, parseReadRequest } from './read-routes'
import { type ServerDeps, handleRequest } from './server'

const PORT = 37_999
const TOKEN = 'a'.repeat(64)
const CWD = '/work/repo'
const MINUTE = 60_000

let temp: TempStore
let reader: MemoryReader | null
let logs: string[]
let ids: number[]
const auth = createDashboardAuth()

beforeEach(() => {
  temp = openTempStore('sam-read-routes-')
  const sessionA = seedMcpSession(temp.store, PROJECT_A, 'claude-code', 'a-1')
  const sessionB = seedMcpSession(temp.store, PROJECT_B, 'opencode', 'b-1')
  ids = [
    seedMcpObservation(temp.store, { sessionId: sessionA, projectKey: PROJECT_A, title: 'Parser drops quoted strings', type: 'bugfix', at: T0 + MINUTE }),
    seedMcpObservation(temp.store, { sessionId: sessionA, projectKey: PROJECT_A, title: 'Spool keeps host event time', type: 'decision', at: T0 + 2 * MINUTE }),
    seedMcpObservation(temp.store, { sessionId: sessionB, projectKey: PROJECT_B, title: 'Parser in the other project', host: 'opencode', at: T0 + 3 * MINUTE }),
  ]
  reader = openMemoryReader(temp.dataDir)
  logs = []
})
afterEach(() => {
  reader?.close()
  temp.cleanup()
})

const projectKeyFor = (cwd: string): ProjectKey => ({ key: cwd === CWD ? PROJECT_A : cwd, kind: 'path', displayName: 'repo' })

// Only the fields the token check and the /read/ dispatch touch; every other route is out of scope here.
function deps(): ServerDeps {
  const reads = { reader: () => reader, projectKeyFor, now: () => NOW }
  return { port: PORT, token: TOKEN, auth, reads, log: (line: string) => logs.push(line) } as unknown as ServerDeps
}

interface Call {
  body?: unknown
  method?: string
  headers?: Record<string, string>
}

function request(path: string, call: Call = {}): Promise<Response> {
  const headers = call.headers ?? { authorization: `Bearer ${TOKEN}` }
  const method = call.method ?? 'POST'
  const body = method === 'GET' ? undefined : JSON.stringify(call.body)
  return handleRequest(new Request(`http://127.0.0.1:${PORT}${path}`, { method, headers: { host: `127.0.0.1:${PORT}`, ...headers }, body }), PORT, deps())
}

const SEARCH = { query: 'parser' }

function argsFor(tool: ReadTool): unknown {
  if (tool === 'timeline') return { anchorId: ids[0] }
  if (tool === 'get_observations') return { ids: [ids[0], ids[2]] }
  return SEARCH
}

test('each read route answers the tool the local server runs', async () => {
  for (const tool of READ_TOOLS) {
    const response = await request(`/read/${tool}`, { body: { args: argsFor(tool), cwd: CWD } })
    expect(response.status).toBe(200)
    const direct = await callTool(tool, argsFor(tool), { reader: () => reader, projectKey: PROJECT_A, now: () => NOW })
    expect(direct).not.toBeNull()
    expect(direct!.count).toBeGreaterThan(0)
    expect(await response.json()).toEqual({ outcome: JSON.parse(JSON.stringify(direct)) })
  }
})

interface SearchAnswer {
  outcome: { result: { isError?: boolean; structuredContent: { status: string; results?: { id: number }[] } } }
}

test('reads and ingest key the same cwd the same way', async () => {
  const daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  try {
    const token = readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
    const post = (path: string, body?: unknown): Promise<Response> =>
      fetch(`http://127.0.0.1:${daemon.port}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    const event: NormalizedEvent = { schemaVersion: SCHEMA_VERSION, eventId: ulid(), host: 'claude-code', hostSessionId: 'wsl-1', kind: 'session_start', occurredAt: Date.now(), cwd: '/home/me/proj' }
    captureEvent(event, { spoolDir: join(temp.dataDir, 'spool'), hmacKey: loadHmacKey(temp.dataDir) })
    expect((await post('/spool/nudge')).status).toBe(202)

    const sessionQuery = temp.store.db.query<{ id: number; project_key: string }, []>("SELECT id, project_key FROM sessions WHERE host_session_id = 'wsl-1'")
    let session = sessionQuery.get()
    for (let tries = 0; session === null && tries < 400; tries += 1) {
      await Bun.sleep(25)
      session = sessionQuery.get()
    }
    expect(session).not.toBeNull()
    const id = seedMcpObservation(temp.store, { sessionId: session!.id, projectKey: session!.project_key, title: 'Wombat cache warms on start', at: Date.now() })

    const found = (await (await post('/read/search', { args: { query: 'wombat' }, cwd: '/home/me/proj' })).json()) as SearchAnswer
    expect(found.outcome.result.structuredContent.results?.map((row) => row.id)).toEqual([id])

    const unresolved = (await (await post('/read/search', { args: { query: 'wombat' }, cwd: null })).json()) as SearchAnswer
    expect(unresolved.outcome.result.isError).toBe(true)
    expect(unresolved.outcome.result.structuredContent.status).toBe('usage_error')
  } finally {
    await daemon.stop()
  }
})

test('the read routes take the token only', async () => {
  const secret = auth.redeemCode(auth.issueCode().code)
  expect(secret).not.toBeNull()
  const cookie = sessionCookie(secret!).split(';')[0]!
  const body = { args: SEARCH, cwd: CWD }
  expect((await request('/read/search', { body, headers: {} })).status).toBe(401)
  expect((await request('/read/search', { body, headers: { cookie, origin: `http://127.0.0.1:${PORT}` } })).status).toBe(401)
  expect((await request('/read/search', { body, headers: { authorization: `Bearer ${'0'.repeat(64)}` } })).status).toBe(401)
})

test('a bad read body is refused', async () => {
  const bad = [
    { args: SEARCH, cwd: CWD, extra: 1 },
    { args: SEARCH, cwd: 'relative/dir' },
    { args: SEARCH, cwd: `/${'a'.repeat(MAX_READ_CWD_CHARS)}` },
    ['not', 'an', 'object'],
  ]
  for (const body of bad) {
    const response = await request('/read/search', { body })
    expect(response.status).toBe(400)
    expect(JSON.stringify(await response.json())).not.toContain('relative/dir')
  }
  expect((await request('/read/search', { method: 'GET' })).status).toBe(405)
  expect((await request('/read/ingest', { body: { args: {}, cwd: CWD } })).status).toBe(404)
})

test('parseReadRequest takes POSIX and Windows absolute paths and refuses NUL', () => {
  expect(parseReadRequest({ args: {}, cwd: '/home/me/proj' })).toEqual({ ok: true, value: { args: {}, cwd: '/home/me/proj' } })
  expect(parseReadRequest({ args: {}, cwd: 'C:\\Users\\me\\proj' }).ok).toBe(true)
  expect(parseReadRequest({ args: {}, cwd: null }).ok).toBe(true)
  expect(parseReadRequest({ args: {}, cwd: `/${'a'.repeat(MAX_READ_CWD_CHARS - 1)}` }).ok).toBe(true)
  expect(parseReadRequest({ args: {}, cwd: '/home/me\0/proj' }).ok).toBe(false)
  expect(parseReadRequest({ args: {}, cwd: 'C:proj' }).ok).toBe(false)
  expect(parseReadRequest({ cwd: '/x' }).ok).toBe(false)
  expect(parseReadRequest({ args: {}, cwd: 7 }).ok).toBe(false)
})

test('the read log carries no query', async () => {
  const response = await request('/read/search', { body: { args: { query: 's3cret-term' }, cwd: CWD } })
  expect(response.status).toBe(200)
  expect(logs.some((line) => /^read search status=200 count=0 ms=\d+$/.test(line))).toBe(true)
  expect(logs.join('\n')).not.toContain('s3cret-term')
})
