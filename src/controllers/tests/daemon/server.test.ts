import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeClaudeCode } from '../../../plugins/adapters/claude-code'
import { captureEvent } from '../../../resources/capture/capture'
import { ulid } from '../../../system/contract/ulid'
import { countSpool } from '../../../resources/spool/spool'
import { loadHmacKey } from '../../../resources/store/hmac-key'
import { type RunningDaemon, startDaemon } from '../../daemon/daemon'
import * as ingest from '../../daemon/ingest'
import * as readRoutes from '../../daemon/read-routes'
import * as server from '../../daemon/server'
import { openStore } from '../../../resources/store/db'
import type { CachingProjectKeyResolver } from '../../../resources/store/project-key'
import { type DbKeyStore, newDbKey } from '../../../resources/sqlite/keys'
import { PROJECT_A, seedMcpObservation, seedMcpSession } from '../mcp/test-support'
import { LATEST_SCHEMA_VERSION } from '../../../resources/store/schema'
import { VERSION } from '../../../system/version'
import { posixOnly } from '../../../../test/platform-guards'

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
  const recorded = JSON.parse(readFileSync(join(import.meta.dir, '../../../../test/fixtures/claude-code/post-tool-use.bash.json'), 'utf8'))
  const payload = { ...recorded, cwd: root, tool_response: { ...recorded.tool_response, stdout: output } }
  const event = normalizeClaudeCode(payload, { now: () => Date.now(), newId: () => ulid() })!
  captureEvent(event, { spoolDir: join(dataDir, 'spool'), hmacKey: loadHmacKey(dataDir) })
  return event.hostSessionId
}

test('GET /health answers without a token', async () => {
  const response = await fetch(url('/health'))
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true, version: VERSION, schemaVersion: LATEST_SCHEMA_VERSION, pid: process.pid, hmacMode: 'legacy', vectorSearch: 'off' })
})

test('GET /health reports the pid the server was given', async () => {
  const real = server.startServer
  const serve = spyOn(server, 'startServer').mockImplementation((deps) => real({ ...deps, pid: 4242 }))
  const other = startDaemon({ dataDir: join(root, 'other'), port: 0, fallbackDrainMs: 60_000, log: () => {} })
  try {
    const body = (await (await fetch(`http://127.0.0.1:${other.port}/health`)).json()) as { pid: unknown }
    expect(body.pid).toBe(4242)
  } finally {
    serve.mockRestore()
    await other.stop()
  }
})

test('each request runs as a named step of the stall watch, by path with ids folded', async () => {
  const real = server.startServer
  const labels: string[] = []
  let given: unknown
  const serve = spyOn(server, 'startServer').mockImplementation((deps) => {
    given = deps.step
    return real({ ...deps, step: (label, fn) => {
      labels.push(label)
      return deps.step === undefined ? fn() : deps.step(label, fn)
    } })
  })
  const other = startDaemon({ dataDir: join(root, 'other'), port: 0, fallbackDrainMs: 60_000, log: () => {} })
  try {
    await fetch(`http://127.0.0.1:${other.port}/health`)
    await fetch(`http://127.0.0.1:${other.port}/memory/sessions/1234/header?x=secret`)
    expect(typeof given).toBe('function')
    expect(labels).toEqual(['route /health', 'route /memory/sessions/:id/header'])
  } finally {
    serve.mockRestore()
    await other.stop()
  }
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

posixOnly('file modes')('daemon.json names the port and pid, and it and the token are 0600', () => {
  const info = JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8'))
  expect(info).toEqual({ pid: process.pid, port: daemon.port })
  for (const file of ['daemon.json', 'daemon.token', 'hmac.key']) expect(statSync(join(dataDir, file)).mode & 0o777).toBe(0o600)
})

test('an event spooled while the daemon was down lands after the next start, once the server is already answering', async () => {
  await daemon.stop()
  const sessionId = spoolFixture('written while down')
  daemon = startDaemon({ dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
  // Each start makes a new token.
  token = readFileSync(join(dataDir, 'daemon.token'), 'utf8').trim()

  // The start did not wait on the spool: the server is up and the entry still waits for the first scheduled drain.
  expect(countSpool(join(dataDir, 'spool'))).toBe(1)
  expect((await fetch(url('/health'))).status).toBe(200)
  await daemon.scheduler.whenIdle()
  expect(countSpool(join(dataDir, 'spool'))).toBe(0)

  const body = (await (await fetch(url('/sessions'), authed())).json()) as { sessions: { hostSessionId: string }[] }
  expect(body.sessions.map((session) => session.hostSessionId)).toEqual([sessionId])
})

test('a /read/ path answers 404 when no read route takes it, and the route answer otherwise', async () => {
  // Mocked both ways, so the test holds whatever the real read routes answer.
  const real = { ...readRoutes }
  const declined = mock(async () => null)
  const stub = mock(async () => ({ status: 200, body: { from: 'read-route' } }))
  mock.module('../../daemon/read-routes', () => ({ ...real, readRoute: declined }))
  try {
    expect((await fetch(url('/read/search'), authed({ method: 'POST', body: '{}' }))).status).toBe(404)
    expect(declined).toHaveBeenCalledTimes(1)
    mock.module('../../daemon/read-routes', () => ({ ...real, readRoute: stub }))
    expect((await fetch(url('/read/search'), { method: 'POST', body: '{}' })).status).toBe(401)
    expect(stub).not.toHaveBeenCalled()
    const answer = await fetch(url('/read/search'), authed({ method: 'POST', body: '{}' }))
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ from: 'read-route' })
    expect(stub).toHaveBeenCalledTimes(1)
  } finally {
    mock.module('../../daemon/read-routes', () => real)
  }
})

test("the daemon hands the read routes its reader and the resolver's key-only lookup, which never walks a repo's history", async () => {
  const serve = spyOn(server, 'startServer')
  const drain = spyOn(ingest, 'drainBatch')
  const otherDir = join(root, 'other')
  const other = startDaemon({ dataDir: otherDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  try {
    await other.scheduler.whenIdle()
    const reads = serve.mock.calls[0]![0].reads!
    // The daemon every test starts with drains too; this one's call is the one on its own spool.
    const resolver = drain.mock.calls.find((call) => call[1].spoolDir === join(otherDir, 'spool'))![1].projectKeyFor as CachingProjectKeyResolver
    expect(reads.projectKeyFor).toBe(resolver.keyOnly)
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

test('the server refuses a body over the cap before reading it', async () => {
  const post = (pad: string): Promise<Response> => fetch(url('/context'), authed({ method: 'POST', body: JSON.stringify({ pad }) }))
  // Three-byte characters: 6,000 of them are under the cap in characters and over it in bytes.
  expect(new TextEncoder().encode('€'.repeat(6_000)).length).toBeGreaterThan(server.MAX_BODY_BYTES)
  expect((await post('€'.repeat(6_000))).status).toBe(413)
  expect((await post('x'.repeat(server.MAX_BODY_BYTES))).status).toBe(413)
  expect((await post('x'.repeat(6_000))).status).toBe(400)
})

test('POST /projects/merge and /projects/split read the request body, not its wrapper', async () => {
  const post = (path: string, body: unknown): Promise<Response> => fetch(url(path), authed({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const merge = await post('/projects/merge', { from: '/no/such/project', into: '/nor/this' })
  expect(merge.status).toBe(409)
  expect(await merge.json()).toMatchObject({ ok: false })
  expect((await post('/projects/split', { key: '/no/such/project' })).status).toBe(409)
  expect((await post('/projects/merge', { from: 'only one key' })).status).toBe(400)
  const broken = await fetch(url('/projects/merge'), authed({ method: 'POST', body: '{not json' }))
  expect(broken.status).toBe(400)
})

test('each start makes a new token, so one captured while the daemon was down stops working', async () => {
  const dir = join(root, 'restarted')
  const first = startDaemon({ dataDir: dir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const old = readFileSync(join(dir, 'daemon.token'), 'utf8').trim()
  await first.stop()
  const second = startDaemon({ dataDir: dir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  try {
    const now = readFileSync(join(dir, 'daemon.token'), 'utf8').trim()
    expect(now).toMatch(/^[0-9a-f]{64}$/)
    expect(now).not.toBe(old)
    const ask = (token: string): Promise<Response> => fetch(`http://127.0.0.1:${second.port}/sessions`, { headers: { authorization: `Bearer ${token}` } })
    expect((await ask(old)).status).toBe(401)
    expect((await ask(now)).status).toBe(200)
    if (process.platform !== 'win32') expect(statSync(join(dir, 'daemon.token')).mode & 0o777).toBe(0o600)
  } finally {
    await second.stop()
  }
})
