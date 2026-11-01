import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { upsertProject, upsertSession } from '../store/writes'
import { type RunningDaemon, startDaemon } from './daemon'
import { MAX_REPORTED_IDS, parseMcpRead } from './mcp-read-route'

let temp: TempStore
let daemon: RunningDaemon
let logs: string[]
beforeEach(() => {
  temp = openTempStore('sam-mcp-read-route-')
  logs = []
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line) })
})
afterEach(async () => {
  await daemon.stop()
  temp.cleanup()
})

const token = (): string => readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
const post = (path: string, body: unknown, auth: string | null = `Bearer ${token()}`): Promise<Response> => fetch(`http://127.0.0.1:${daemon.port}${path}`, {
  method: 'POST', headers: { ...(auth === null ? {} : { authorization: auth }), 'content-type': 'application/json' }, body: JSON.stringify(body),
})
const rows = (sql: string) => temp.store.db.query(sql).all() as Record<string, unknown>[]
const REPORT = { tool: 'get_observations', projectKey: '/work/repo', host: 'claude-code', returnedIds: [3, 4], rows: 2, ms: 1.4, status: 'ok' }

test('a valid report is stored as one mcp_reads row; the log holds counts, not the project key', async () => {
  const response = await post('/metrics/mcp-read', REPORT)
  expect(response.status).toBe(201)
  expect(rows('SELECT project_key, host, tool, returned_ids, rows, ms, status FROM mcp_reads')).toEqual([
    { project_key: '/work/repo', host: 'claude-code', tool: 'get_observations', returned_ids: '[3,4]', rows: 2, ms: 1, status: 'ok' },
  ])
  expect(logs).toContain('mcp read tool=get_observations host=claude-code status=ok rows=2 ids=2 ms=1')
  expect(logs.join('\n')).not.toContain('/work/repo')
  expect((await post('/metrics/mcp-read', { ...REPORT, host: null, projectKey: '*' })).status).toBe(201)
})

test('the route needs the token: none, a wrong one and a dashboard-style cookie are refused', async () => {
  expect((await post('/metrics/mcp-read', REPORT, null)).status).toBe(401)
  expect((await post('/metrics/mcp-read', REPORT, `Bearer ${'0'.repeat(64)}`)).status).toBe(401)
  const cookie = await fetch(`http://127.0.0.1:${daemon.port}/metrics/mcp-read`, { method: 'POST', headers: { cookie: 'sam_session=x' }, body: JSON.stringify(REPORT) })
  expect(cookie.status).toBe(401)
  expect((await fetch(`http://127.0.0.1:${daemon.port}/metrics/mcp-read`, { headers: { authorization: `Bearer ${token()}` } })).status).toBe(405)
  expect(rows('SELECT count(*) AS n FROM mcp_reads')).toEqual([{ n: 0 }])
})

test('bodies with extra keys, query text, bad ids, an unknown tool or status are 400 without echoing them', async () => {
  const bad = [
    { ...REPORT, query: 'SECRET-QUERY-TEXT' },
    { ...REPORT, arguments: { query: 'SECRET-QUERY-TEXT' } },
    { ...REPORT, text: 'SECRET-QUERY-TEXT' },
    (({ host: _host, ...rest }) => rest)(REPORT),
    { ...REPORT, tool: 'write_memory' },
    { ...REPORT, status: 'SECRET-QUERY-TEXT' },
    { ...REPORT, returnedIds: [1.5] },
    { ...REPORT, returnedIds: [0] },
    { ...REPORT, returnedIds: ['3'] },
    { ...REPORT, returnedIds: Array.from({ length: MAX_REPORTED_IDS + 1 }, (_, index) => index + 1) },
    { ...REPORT, rows: -1 },
    { ...REPORT, ms: Number.MAX_SAFE_INTEGER },
    { ...REPORT, projectKey: '' },
    { ...REPORT, host: 'Not A Host' },
    [REPORT],
  ]
  for (const body of bad) {
    const response = await post('/metrics/mcp-read', body)
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('SECRET')
  }
  expect(rows('SELECT count(*) AS n FROM mcp_reads')).toEqual([{ n: 0 }])
  expect(logs.join('\n')).not.toContain('SECRET')
  expect(parseMcpRead({ ...REPORT, returnedIds: Array.from({ length: MAX_REPORTED_IDS }, (_, index) => index + 1) }).ok).toBe(true)
})

test('POST /context records duration_ms on every injection, for the pack and for the prompt delta', async () => {
  const project = temp.root
  upsertProject(temp.store.db, { key: project, kind: 'path', displayName: 'route-repo' }, T0)
  upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'cc-1', projectKey: project, cwd: project, occurredAt: T0 })
  const other = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc-1', projectKey: project, cwd: project, occurredAt: T0 })
  seedObservation(temp.store, { sessionId: other, projectKey: project, host: 'opencode', title: 'In the pack', at: T0 })
  const body = { host: 'claude-code', cwd: project, hostSessionId: 'cc-1', channel: 'session_start' }
  expect((await post('/context', body)).status).toBe(200)
  seedObservation(temp.store, { sessionId: other, projectKey: project, host: 'opencode', title: 'Learned after the pack', at: Date.now() + 1_000 })
  const delta = (await (await post('/context', { ...body, channel: 'prompt' })).json()) as { text: string; observationIds: number[] }
  expect(delta.text).toContain('Learned after the pack')
  expect(delta.observationIds).toHaveLength(1)

  const stored = rows('SELECT channel, duration_ms AS durationMs FROM injections ORDER BY id') as { channel: string; durationMs: number | null }[]
  expect(stored.map((row) => row.channel)).toEqual(['session_start', 'prompt'])
  for (const row of stored) {
    expect(Number.isInteger(row.durationMs)).toBe(true)
    expect(row.durationMs!).toBeGreaterThanOrEqual(0)
  }
  expect(logs.some((line) => /^context host=claude-code channel=prompt injection=\d+ ids=1 tokens=\d+ rebuilt=false key_ms=\d+ ms=\d+$/.test(line))).toBe(true)
  expect(logs.join('\n')).not.toContain('Learned after the pack')
  // A second prompt has nothing new: empty text, nothing recorded.
  expect(await (await post('/context', { ...body, channel: 'prompt' })).json()).toEqual({ text: '', observationIds: [], tokens: 0 })
  expect(rows('SELECT count(*) AS n FROM injections')).toEqual([{ n: 2 }])
})
