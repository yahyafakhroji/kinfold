import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeClaudeCode } from '../adapters/claude-code'
import { captureEvent } from '../capture/capture'
import { ulid } from '../contract/ulid'
import { loadHmacKey } from '../store/hmac-key'
import { type RunningDaemon, startDaemon } from './daemon'
import * as ingest from './ingest'
import * as readRoutes from './read-routes'
import * as server from './server'
import { openStore } from '../store/db'
import { type DbKeyStore, newDbKey } from '../sqlite/keys'
import { PROJECT_A, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import { LATEST_SCHEMA_VERSION } from '../store/schema'
import { VERSION } from '../version'

let root: string
let dataDir: string
let daemon: RunningDaemon
let logs: string[]
let token: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sam-server-'))
  dataDir = join(root, 'data')
  logs = []
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
  token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()
})
afterEach(async () => {
  await daemon.stop()
  rmSync(root, { recursive: true, force: true })
})

const url = (path: string): string => `http://127.0.0.1:${daemon.port}${path}`
const authed = (init: RequestInit = {}): RequestInit => ({ ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } })

function spoolFixture(output: string): string {
  const recorded = JSON.parse(readFileSync(join(import.meta.dir, '../../test/fixtures/claude-code/post-tool-use.bash.json'), 'utf8'))
  const payload = { ...recorded, cwd: root, tool_response: { ...recorded.tool_response, stdout: output } }
  const event = normalizeClaudeCode(payload, { now: () => Date.now(), newId: () => ulid() })!
  captureEvent(event, { spoolDir: join(dataDir, 'spool'), hmacKey: loadHmacKey(dataDir) })
  return event.hostSessionId
}

test('GET /health answers without a token', async () => {
  const response = await fetch(url('/health'))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, version: VERSION, schemaVersion: LATEST_SCHEMA_VERSION, hmacMode: 'legacy', vectorSearch: 'off' })
})

test('every other route is 401 without the token or with a wrong one', async () => {
  for (const [path, method] of [['/sessions', 'GET'], ['/spool/nudge', 'POST'], ['/nope', 'GET']] as const) {
    expect((await fetch(url(path), { method })).status).toBe(401)
    const wrong = await fetch(url(path), { method, headers: { authorization: `Bearer ${'0'.repeat(64)}` } })
    expect(wrong.status).toBe(401)
  }
})

test('a foreign Host header is 403, even with the token and on /health', async () => {
  for (const host of ['evil.example:80', `evil.example:${daemon.port}`, '127.0.0.1']) {
    expect((await fetch(url('/health'), { headers: { host } })).status).toBe(403)
    expect((await fetch(url('/sessions'), authed({ headers: { host } }))).status).toBe(403)
  }
  expect((await fetch(url('/health'), { headers: { host: `localhost:${daemon.port}` } })).status).toBe(200)
})

test('no response carries CORS headers, preflight included', async () => {
  const responses = [
    await fetch(url('/health'), { headers: { origin: 'https://evil.example' } }),
    await fetch(url('/sessions'), { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }),
    await fetch(url('/sessions'), authed({ headers: { origin: 'https://evil.example' } })),
  ]
  for (const response of responses) {
    expect([...response.headers.keys()].filter((name) => name.startsWith('access-control-'))).toEqual([])
  }
})

test('a nudge returns 202 at once and the spooled event is ingested', async () => {
  const sessionId = spoolFixture('42 pass')
  const nudge = await fetch(url('/spool/nudge'), authed({ method: 'POST' }))
  expect(nudge.status).toBe(202)
  await daemon.scheduler.whenIdle()

  const body = (await (await fetch(url(`/sessions?project=${encodeURIComponent(root)}`), authed())).json()) as {
    sessions: { hostSessionId: string; eventCount: number; host: string }[]
  }
  expect(body.sessions).toEqual([expect.objectContaining({ hostSessionId: sessionId, host: 'claude-code', eventCount: 1 })])
})

test('the nudge route only accepts POST', async () => {
  expect((await fetch(url('/spool/nudge'), authed())).status).toBe(405)
})

test('logs carry counts and ids, never the payload', async () => {
  spoolFixture('very-distinct-output-marker')
  await fetch(url('/spool/nudge'), authed({ method: 'POST' }))
  await daemon.scheduler.whenIdle()

  expect(logs.some((line) => line.startsWith('drained read=1 inserted=1'))).toBe(true)
  expect(logs.join('\n')).not.toContain('very-distinct-output-marker')
})

test('daemon.json names the port and pid, and it and the token are 0600', () => {
  const info = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
  expect(info).toEqual({ pid: process.pid, port: daemon.port })
  for (const file of ['daemon.json', 'daemon.token', 'hmac.key']) expect(statSync(join(dataDir, file)).mode & 0o777).toBe(0o600)
})

test('an event spooled while the daemon was down lands on the next start', async () => {
  await daemon.stop()
  const sessionId = spoolFixture('written while down')
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })

  const body = (await (await fetch(url('/sessions'), authed())).json()) as { sessions: { hostSessionId: string }[] }
  expect(body.sessions.map((session) => session.hostSessionId)).toEqual([sessionId])
})

test('a /read/ path answers 404 when no read route takes it, and the route answer otherwise', async () => {
  // Mocked both ways, so the test holds whatever the real read routes answer.
  const real = { ...readRoutes }
  const declined = mock(async () => null)
  const stub = mock(async () => ({ status: 200, body: { from: 'read-route' } }))
  mock.module('./read-routes', () => ({ ...real, readRoute: declined }))
  try {
    expect((await fetch(url('/read/search'), authed({ method: 'POST', body: '{}' }))).status).toBe(404)
    expect(declined).toHaveBeenCalledTimes(1)
    mock.module('./read-routes', () => ({ ...real, readRoute: stub }))
    expect((await fetch(url('/read/search'), { method: 'POST', body: '{}' })).status).toBe(401)
    expect(stub).not.toHaveBeenCalled()
    const answer = await fetch(url('/read/search'), authed({ method: 'POST', body: '{}' }))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ from: 'read-route' })
    expect(stub).toHaveBeenCalledTimes(1)
  } finally {
    mock.module('./read-routes', () => real)
  }
})

test('the daemon hands the read routes its reader and resolver', async () => {
  const serve = spyOn(server, 'startServer')
  const drain = spyOn(ingest, 'drainSpool')
  const otherDir = join(root, 'other')
  const other = startDaemon({ dataDir: otherDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  try {
    const reads = serve.mock.calls[0]![0].reads!
    expect(reads.projectKeyFor).toBe(drain.mock.calls[0]![1].projectKeyFor)
    const writer = openStore(otherDir)
    const sessionId = seedMcpSession(writer, PROJECT_A, 'claude-code', 'r-1')
    const id = seedMcpObservation(writer, { sessionId, projectKey: PROJECT_A, title: 'Seen through the daemon reader', at: Date.now() })
    writer.db.close()
    expect(reads.reader()?.observation(id, null)?.title).toBe('Seen through the daemon reader')
  } finally {
    serve.mockRestore()
    drain.mockRestore()
    await other.stop()
  }
})

// Windows keeps the reader's file locked past the temp folder cleanup, as in the test above.
test.skipIf(process.platform === 'win32')("the daemon's reader opens an encrypted store with the daemon's keys and asks the store once", async () => {
  const serve = spyOn(server, 'startServer')
  const encryptedDir = join(root, 'encrypted')
  const key = newDbKey()
  let reads = 0
  const keys: DbKeyStore = { name: 'counting', read: () => (reads++, key), exists: () => true }
  const writer = openStore(encryptedDir, { keys: { ...keys, read: () => key } })
  const sessionId = seedMcpSession(writer, PROJECT_A, 'claude-code', 'r-1')
  const id = seedMcpObservation(writer, { sessionId, projectKey: PROJECT_A, title: 'Read with the daemon key', at: Date.now() })
  writer.db.close()
  const other = startDaemon({ dataDir: encryptedDir, port: 0, fallbackDrainMs: 60_000, log: () => {}, dbKeys: keys })
  try {
    const routes = serve.mock.calls[0]![0].reads!
    expect(routes.reader()?.observation(id, null)?.title).toBe('Read with the daemon key')
    // The writer and the reader both opened the file; the store was read once.
    expect(reads).toBe(1)
  } finally {
    serve.mockRestore()
    await other.stop()
  }
  expect(reads).toBe(1)
})
