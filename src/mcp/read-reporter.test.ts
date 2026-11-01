import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { upsertProject, upsertSession } from '../store/writes'
import { REPORT_TIMEOUT_MS, createReadReporter, hostFromEnv } from './read-reporter'
import { createMcpServer } from './server'

let temp: TempStore
let daemon: RunningDaemon | null
beforeEach(() => {
  temp = openTempStore('sam-mcp-reporter-')
  daemon = null
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  temp.cleanup()
})

const READ = { tool: 'search' as const, projectKey: '/work/repo', returnedIds: [1], rows: 1, ms: 0.4, status: 'ok' as const }
const call = (id: number, name: string, args: unknown): string => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })

/** An MCP server over the temp store, keyed by a path project with two observations. */
function serverWith(reporter?: ReturnType<typeof createReadReporter>, logs: string[] = []) {
  const server = createMcpServer({ dataDir: temp.dataDir, cwd: temp.root, git: () => null, now: () => T0 + 60_000, log: (line) => logs.push(line), ...(reporter !== undefined ? { reporter } : {}) })
  const key = server.projectKey!
  upsertProject(temp.store.db, { key, kind: 'path', displayName: 'repo' }, T0)
  const session = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc', projectKey: key, cwd: key, occurredAt: T0 })
  const ids = ['Reporter sends ids only', 'Second reporter fact'].map((title, index) => seedObservation(temp.store, { sessionId: session, projectKey: key, host: 'opencode', title, at: T0 + index }))
  return { server, key, ids }
}

test('hostFromEnv takes a short lowercase name and nothing else', async () => {
  expect(hostFromEnv({ SAM_MCP_HOST: 'opencode' })).toBe('opencode')
  expect(hostFromEnv({})).toBeNull()
  expect(hostFromEnv({ SAM_MCP_HOST: 'Claude Code; rm -rf' })).toBeNull()
})

test('fire and forget: the reply comes back before the post starts and is the same with or without a reporter', async () => {
  const queued: (() => void)[] = []
  const posted: string[] = []
  const fetchSpy = async (url: string): Promise<Response> => {
    posted.push(url)
    return new Response('{}', { status: 201 })
  }
  mkdirSync(temp.dataDir, { recursive: true })
  writeFileSync(join(temp.dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 1 }))
  writeFileSync(join(temp.dataDir, 'daemon.token'), 'a'.repeat(64))
  const reporter = createReadReporter({ dataDir: temp.dataDir, host: 'claude-code', fetch: fetchSpy, schedule: (task) => queued.push(task) })
  const { server, ids } = serverWith(reporter)
  const plain = createMcpServer({ dataDir: temp.dataDir, cwd: temp.root, git: () => null, now: () => T0 + 60_000 })

  const line = call(1, 'get_observations', { ids })
  const reply = await server.handleLine(line)
  expect(queued).toHaveLength(1)
  expect(posted).toEqual([])
  expect(reply).toBe(await plain.handleLine(line))
  queued.shift()!()
  await reporter.settled()
  expect(posted).toEqual(['http://127.0.0.1:1/metrics/mcp-read'])
  server.close()
  plain.close()
})

test('a fetch that throws at once still leaves the reply alone and only counts a drop', async () => {
  mkdirSync(temp.dataDir, { recursive: true })
  writeFileSync(join(temp.dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: 1 }))
  writeFileSync(join(temp.dataDir, 'daemon.token'), 'a'.repeat(64))
  const reporter = createReadReporter({ dataDir: temp.dataDir, host: null, fetch: () => { throw new Error('boom') } })
  const logs: string[] = []
  const { server } = serverWith(reporter, logs)
  const reply = JSON.parse((await server.handleLine(call(1, 'search', { query: 'reporter' })))!) as { result: { structuredContent: { status: string } } }
  expect(reply.result.structuredContent.status).toBe('ok')
  await reporter.settled()
  expect(reporter.drops()).toBe(1)
  await server.handleLine(call(2, 'search', { query: 'reporter' }))
  expect(logs.at(-1)).toMatch(/^tool=search status=ok rows=2 ms=[\d.]+ report_drops=1$/)
  await reporter.settled()
  server.close()
})

test('with the daemon down, reports are dropped silently and counted', async () => {
  const reporter = createReadReporter({ dataDir: temp.dataDir, host: 'opencode' })
  reporter.report(READ)
  reporter.report(READ)
  await reporter.settled()
  expect(reporter.drops()).toBe(2)
})

test('a daemon that never answers costs one 200 ms timeout per report, off the reply path', async () => {
  const hung = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) })
  try {
    mkdirSync(temp.dataDir, { recursive: true })
    writeFileSync(join(temp.dataDir, 'daemon.json'), JSON.stringify({ pid: 1, port: hung.port }))
    writeFileSync(join(temp.dataDir, 'daemon.token'), 'a'.repeat(64))
    const reporter = createReadReporter({ dataDir: temp.dataDir, host: 'opencode' })
    const startedAt = performance.now()
    reporter.report(READ)
    expect(performance.now() - startedAt).toBeLessThan(20)
    await reporter.settled()
    const waited = performance.now() - startedAt
    expect(waited).toBeGreaterThanOrEqual(REPORT_TIMEOUT_MS - 20)
    expect(waited).toBeLessThan(REPORT_TIMEOUT_MS + 300)
    expect(reporter.drops()).toBe(1)
  } finally {
    hung.stop(true)
  }
})

test('end to end: one get_observations call becomes one mcp_reads row through a temp daemon', async () => {
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const reporter = createReadReporter({ dataDir: temp.dataDir, host: 'claude-code' })
  const { server, key, ids } = serverWith(reporter)
  await server.handleLine(call(1, 'get_observations', { ids: [...ids, 999_999] }))
  await server.handleLine(call(2, 'search', { query: 'nothing-matches-this' }))
  await reporter.settled()
  expect(reporter.drops()).toBe(0)
  const stored = temp.store.db.query('SELECT project_key AS projectKey, host, tool, returned_ids AS ids, rows, status FROM mcp_reads ORDER BY id').all()
  expect(stored).toEqual([
    { projectKey: key, host: 'claude-code', tool: 'get_observations', ids: JSON.stringify(ids), rows: 2, status: 'ok' },
    { projectKey: key, host: 'claude-code', tool: 'search', ids: '[]', rows: 0, status: 'ok' },
  ])
  server.close()
})
