import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FRAGMENT, markV1 } from '../data-control/test-support'
import { type TempStore, T0, openTempStore, seedEvent, seedSession } from '../observer/test-support'
import type { Exclusive } from '../vectors/vector-worker'
import { type RunningDaemon, startDaemon } from './daemon'
import { type DataHandlers, dataRoute } from './data-routes'
import { SizeStillComputingError } from './size-cache'

let temp: TempStore
let daemon: RunningDaemon
let logs: string[]
let session: number

beforeEach(() => {
  temp = openTempStore('sam-data-routes-')
  session = seedSession(temp.store, 'claude-code', 'cc-1')
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0, promptNumber: 1, tool: { name: 'Bash', output: `key ${FRAGMENT} printed`, exitCode: 0 } })
  markV1(temp, 'events')
  logs = []
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
})
afterEach(async () => {
  await daemon.stop()
  temp.cleanup()
})

const token = (): string => readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
const url = (path: string): string => `http://127.0.0.1:${daemon.port}${path}`
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url(path), { method, headers: { authorization: `Bearer ${token()}`, ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })

const ROUTES = [
  ['GET', '/data/size'], ['GET', '/data/retention'], ['PUT', '/data/retention'], ['POST', '/data/scan'],
  ['GET', '/data/findings'], ['POST', '/data/findings/1/resolve'], ['POST', '/data/purge'],
] as const

test('every /data route is 401 without the token and 403 with a foreign Host', async () => {
  for (const [method, path] of ROUTES) {
    expect((await fetch(url(path), { method })).status).toBe(401)
    expect((await call(method, path, undefined, { authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401)
    expect((await call(method, path, undefined, { host: `evil.example:${daemon.port}` })).status).toBe(403)
  }
})

test('scan, findings and resolve over HTTP never carry the secret, in answers or logs', async () => {
  const scan = await call('POST', '/data/scan', {})
  expect(scan.status).toBe(200)
  const scanText = await scan.text()
  expect(JSON.parse(scanText)).toMatchObject({ scanned: 1, findings: 1, byRule: { key_fragment: 1 }, remaining: 0 })

  const listed = await call('GET', '/data/findings')
  const listText = await listed.text()
  const view = JSON.parse(listText) as { findings: { id: number; rule: string }[]; pendingByRule: Record<string, number> }
  expect(view.pendingByRule).toEqual({ key_fragment: 1 })
  expect(view.findings.map((finding) => finding.rule)).toEqual(['key_fragment'])

  const id = view.findings[0]!.id
  const resolved = await call('POST', `/data/findings/${id}/resolve`, { action: 'redact' })
  const resolvedText = await resolved.text()
  expect(resolved.status).toBe(200)
  expect(JSON.parse(resolvedText)).toMatchObject({ resolved: { id, action: 'redacted' }, purge: null })
  expect((await call('POST', `/data/findings/${id}/resolve`, { action: 'purge' })).status).toBe(409)
  expect((await call('POST', '/data/findings/999/resolve', { action: 'purge' })).status).toBe(404)
  expect((await call('POST', `/data/findings/${id}/resolve`, { action: 'delete' })).status).toBe(400)
  expect((await call('GET', `/data/findings/${id}/resolve`)).status).toBe(405)
  expect(JSON.parse(await (await call('GET', '/data/findings?action=all')).text()).findings).toHaveLength(1)

  for (const text of [scanText, listText, resolvedText, logs.join('\n')]) {
    expect(text).not.toContain(FRAGMENT)
    expect(text).not.toContain('Qz7Wx')
  }
  expect(logs).toContain(`data finding resolve id=${id} action=redact ok`)
})

test('size and retention answer with their shapes; a bad PUT is 400 and names the field only', async () => {
  const size = (await (await call('GET', '/data/size')).json()) as Record<string, unknown>
  expect(size).toMatchObject({ source: 'dbstat', overWarn: false, files: { db: expect.any(Number), wal: expect.any(Number), shm: expect.any(Number) } })
  expect(await (await call('GET', '/data/retention')).json()).toEqual({ retention: { events: 30, prompts: null, observations: null, summaries: null }, warnBytes: 268_435_456 })

  const put = await call('PUT', '/data/retention', { retention: { events: 7, prompts: null }, warnBytes: 1_000_000 })
  expect(await put.json()).toMatchObject({ saved: { retention: { events: 7, prompts: null }, warnBytes: 1_000_000 }, applied: { prompts: 0, observations: 0 } })
  expect(logs.some((line) => line.startsWith('data retention saved events=7 prompts=null'))).toBe(true)
  const bad = await call('PUT', '/data/retention', { retention: { events: 0, secretish: 'SECRET-VALUE' } })
  expect(bad.status).toBe(400)
  expect(await bad.text()).not.toContain('SECRET-VALUE')
  expect((await call('POST', '/data/size')).status).toBe(405)
  expect((await call('GET', '/data/findings?limit=0')).status).toBe(400)
})

test('retention writes, purge and resolve run through exclusive; reads and previews do not', async () => {
  const seen: string[] = []
  const handlers = {
    size: () => { seen.push('size'); return {} },
    previewRetention: () => { seen.push('preview'); return {} },
    putRetention: () => { seen.push('put'); return {} },
    purge: () => { seen.push('purge'); return {} },
    resolve: () => { seen.push('resolve'); return { ok: true, finding: {}, purge: null } },
  } as unknown as DataHandlers
  const exclusive: Exclusive = async (fn) => {
    seen.push('exclusive')
    return fn()
  }
  const body = (value: unknown) => async () => ({ ok: true as const, value })
  const at = (path: string) => new URL(`http://127.0.0.1${path}`)
  await dataRoute('GET', at('/data/size'), body(null), handlers, exclusive)
  await dataRoute('PUT', at('/data/retention'), body({ retention: { events: 30 }, preview: true }), handlers, exclusive)
  await dataRoute('PUT', at('/data/retention'), body({ retention: { events: 30 } }), handlers, exclusive)
  await dataRoute('POST', at('/data/purge'), body({ before: new Date(T0).toISOString() }), handlers, exclusive)
  await dataRoute('POST', at('/data/findings/1/resolve'), body({ action: 'redact' }), handlers, exclusive)
  expect(seen).toEqual(['size', 'preview', 'exclusive', 'put', 'exclusive', 'purge', 'exclusive', 'resolve'])
})

test('purge validates its selector and supports a dry run', async () => {
  const dry = await call('POST', '/data/purge', { session, dryRun: true })
  expect(await dry.json()).toMatchObject({ dryRun: true, target: 'session', counts: { sessions: 1, events: 1 }, scrub: null })
  expect(temp.store.db.query('SELECT count(*) AS n FROM events').get()).toEqual({ n: 1 })
  for (const body of [{}, { session, host: 'claude-code' }, { session: 'one' }, { before: 'not a date' }, { session, extra: true }, { before: '2026-01-02', after: '2026-03-01' }]) {
    expect((await call('POST', '/data/purge', body)).status).toBe(400)
  }
  const real = await call('POST', '/data/purge', { before: new Date(T0 + 1).toISOString() })
  expect(await real.json()).toMatchObject({ dryRun: false, target: 'range', counts: { events: 1 } })
  expect(logs.some((line) => line.startsWith('data purge target=range dry_run=false'))).toBe(true)
})

test('PUT /data/retention with preview: true answers counts and bytes, saves nothing, and logs counts only', async () => {
  temp.store.db.run("UPDATE events SET observer_state = 'done'")
  const before = await (await call('GET', '/data/retention')).json()
  const answer = await call('PUT', '/data/retention', { retention: { events: 1, prompts: 1 }, preview: true })
  expect(answer.status).toBe(200)
  const text = await answer.text()
  const body = JSON.parse(text) as { preview: { settings: { retention: Record<string, number | null> }; tables: Record<string, { rows: number; bytes: number }> } }
  expect(body.preview.settings.retention).toMatchObject({ events: 1, prompts: 1 })
  expect(body.preview.tables.events!.rows).toBe(1)
  expect(body.preview.tables.events!.bytes).toBeGreaterThan(0)
  expect(text).not.toContain(FRAGMENT)
  expect(await (await call('GET', '/data/retention')).json()).toEqual(before)
  const row = temp.store.db.query('SELECT payload_expired_at AS at FROM events').get() as { at: number | null }
  expect(row.at).toBeNull()
  expect(logs.some((line) => /^data retention preview events=1 prompts=0 observations=0 summaries=0 ms=\d+$/.test(line))).toBe(true)
  expect(logs.some((line) => line.startsWith('data retention saved'))).toBe(false)
  expect((await call('PUT', '/data/retention', { retention: { events: 1 }, preview: 'yes' })).status).toBe(400)
  expect((await call('PUT', '/data/retention', { preview: true, extra: 1 })).status).toBe(400)
})

test('a size report still being worked out answers 503 with what to do, never a dropped connection', async () => {
  const handlers = { size: async () => { throw new SizeStillComputingError() } } as unknown as DataHandlers
  const answer = await dataRoute('GET', new URL('http://127.0.0.1/data/size'), async () => ({ ok: true as const, value: null }), handlers)
  expect(answer).toEqual({ status: 503, body: { error: 'the size report is still being worked out on this store; try again in a minute' } })
})

test('the size report says when it was measured', async () => {
  const size = (await (await call('GET', '/data/size')).json()) as Record<string, unknown>
  expect(size.measuredAt).toEqual(expect.any(Number))
})

test('a purge shows on the dashboard overview at once: the kept report is computed again, not served from before', async () => {
  const sessions = async (): Promise<number> => ((await (await call('GET', '/memory/overview')).json()) as { value: { sessions: number } }).value.sessions
  expect(await sessions()).toBe(1)
  // A dry run removed nothing, so the kept report stands.
  expect((await call('POST', '/data/purge', { session, dryRun: true })).status).toBe(200)
  expect(await sessions()).toBe(1)
  expect((await call('POST', '/data/purge', { session })).status).toBe(200)
  expect(await sessions()).toBe(0)
})

test('GET /data/findings/<id> answers one finding whatever its state, 404 for none, and never the matched text', async () => {
  await call('POST', '/data/scan', {})
  const listed = (await (await call('GET', '/data/findings')).json()) as { findings: { id: number }[] }
  const id = listed.findings[0]!.id
  const one = await call('GET', `/data/findings/${id}`)
  const text = await one.text()
  expect(one.status).toBe(200)
  expect(JSON.parse(text)).toMatchObject({ finding: { id, table: 'events', rule: 'key_fragment', action: 'pending' } })
  expect(text).not.toContain(FRAGMENT)
  expect((await call('GET', '/data/findings/999999')).status).toBe(404)
  expect((await call('DELETE', `/data/findings/${id}`)).status).toBe(405)
  // Still there after it is resolved, so a caller can tell "resolved" from "never existed".
  await call('POST', `/data/findings/${id}/resolve`, { action: 'redact' })
  expect(((await (await call('GET', `/data/findings/${id}`)).json()) as { finding: { action: string } }).finding.action).toBe('redacted')
})
