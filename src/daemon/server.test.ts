import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeClaudeCode } from '../adapters/claude-code'
import { captureEvent } from '../capture/capture'
import { ulid } from '../contract/ulid'
import { loadHmacKey } from '../store/hmac-key'
import { type RunningDaemon, startDaemon } from './daemon'
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
