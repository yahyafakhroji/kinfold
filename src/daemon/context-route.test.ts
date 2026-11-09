import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { type TempStore, T0, fakeRunner, openTempStore, seedEvent } from '../observer/test-support'
import { MAX_OBSERVER_ATTEMPTS } from '../store/observer-store'
import { upsertProject, upsertSession } from '../store/writes'
import { DAEMON_ONLY_TIMEOUT_MS } from '../context/daemon'
import { PROMPT_SERVE_BUDGET_MS, contextHandler, shownBudgetMs } from './context-route'
import { readUpdateState, writeUpdateState } from '../update/state'
import { type RunningDaemon, startDaemon } from './daemon'

let temp: TempStore
let daemon: RunningDaemon | null
let logs: string[]
let projectKey: string
let session: number

beforeEach(() => {
  temp = openTempStore('sam-context-route-')
  daemon = null
  logs = []
  // The temp root is not a git checkout, so the daemon's resolver keys it by path.
  projectKey = temp.root
  upsertProject(temp.store.db, { key: projectKey, kind: 'path', displayName: 'route-repo' }, T0)
  session = upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'cc-1', projectKey, cwd: projectKey, occurredAt: T0 })
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  temp.cleanup()
})

function start(observer?: Parameters<typeof startDaemon>[0]['observer']): RunningDaemon {
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: (line) => logs.push(line), ...(observer !== undefined ? { observer } : {}) })
  return daemon
}

const token = (): string => readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
const url = (path: string): string => `http://127.0.0.1:${daemon!.port}${path}`
const post = (path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(url(path), { method: 'POST', headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const contextBody = (hostSessionId = 'cc-1') => ({ host: 'claude-code', cwd: projectKey, hostSessionId, channel: 'session_start' })
const rows = (sql: string) => temp.store.db.query(sql).all() as Record<string, unknown>[]

test('POST /context resolves the project from cwd, returns the pack and records the injection', async () => {
  const id = seedObservation(temp.store, { sessionId: session, projectKey, host: 'opencode', title: 'Route serves stored packs', at: T0 })
  start()
  const response = await post('/context', contextBody())
  expect(response.status).toBe(200)
  const body = (await response.json()) as { text: string; observationIds: number[]; tokens: number }
  expect(body.text).toContain(`Route serves stored packs (#${id})`)
  expect(body.observationIds).toEqual([id])
  expect(body.tokens).toBeGreaterThan(0)
  expect(rows('SELECT session_id, host, host_session_id, channel, tokens FROM injections')).toEqual([
    { session_id: session, host: 'claude-code', host_session_id: 'cc-1', channel: 'session_start', tokens: body.tokens },
  ])
  expect(logs.some((line) => line.startsWith('context host=claude-code channel=session_start'))).toBe(true)
  expect(logs.join('\n')).not.toContain('Route serves stored packs')
  expect(logs.join('\n')).not.toContain(projectKey)
})

test('POST /context needs the token and a loopback Host, like every other route', async () => {
  start()
  const anonymous = await fetch(url('/context'), { method: 'POST', body: JSON.stringify(contextBody()) })
  expect(anonymous.status).toBe(401)
  expect((await post('/context', contextBody(), { authorization: `Bearer ${'0'.repeat(64)}` })).status).toBe(401)
  expect((await post('/context', contextBody(), { host: `evil.example:${daemon!.port}` })).status).toBe(403)
  expect((await post('/observer/retry', { all: true }, { host: 'evil.example' })).status).toBe(403)
  expect((await fetch(url('/observer/retry'), { method: 'POST', body: '{"all":true}' })).status).toBe(401)
})

test('bad bodies are 400 without echoing them, and GET is 405', async () => {
  start()
  for (const body of [{}, { ...contextBody(), cwd: 'relative/path' }, { ...contextBody(), channel: 'mcp' }, { ...contextBody(), hostSessionId: '' }]) {
    expect((await post('/context', body)).status).toBe(400)
  }
  const raw = await fetch(url('/context'), { method: 'POST', headers: { authorization: `Bearer ${token()}` }, body: 'SECRET-NOT-JSON' })
  expect(raw.status).toBe(400)
  expect(await raw.text()).not.toContain('SECRET')
  expect((await fetch(url('/context'), { headers: { authorization: `Bearer ${token()}` } })).status).toBe(405)
  expect((await post('/observer/retry', {})).status).toBe(400)
})

test('a warm pack serves 50 calls well inside 1.5 s', async () => {
  for (let index = 0; index < 40; index += 1) {
    seedObservation(temp.store, { sessionId: session, projectKey, host: index % 2 === 0 ? 'claude-code' : 'opencode', title: `Fact ${index} about part p${index * 17}`, at: T0 + index })
  }
  start()
  expect((await post('/context', contextBody())).status).toBe(200)
  const startedAt = performance.now()
  const timings: number[] = []
  for (let call = 0; call < 50; call += 1) {
    const before = performance.now()
    expect((await post('/context', contextBody(`cc-${call}`))).status).toBe(200)
    timings.push(performance.now() - before)
  }
  expect(performance.now() - startedAt).toBeLessThan(1_500)
  timings.sort((a, b) => a - b)
  expect(timings[Math.floor(timings.length * 0.95)]!).toBeLessThan(30)
  expect(rows('SELECT count(*) AS n FROM injections')).toEqual([{ n: 51 }])
})

test('POST /observer/retry resets failed events for one session or for all', async () => {
  const other = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc-1', projectKey, cwd: projectKey, occurredAt: T0 })
  const ids = [seedEvent(temp.store, session, { kind: 'turn_end', at: T0 }), seedEvent(temp.store, other, { kind: 'turn_end', at: T0 })]
  temp.store.db.run(`UPDATE events SET observer_state = 'failed', observer_attempts = ${MAX_OBSERVER_ATTEMPTS}, observer_retry_at = 1`)
  start()

  expect(await (await post('/observer/retry', { sessionId: session })).json()).toEqual({ reset: 1 })
  expect(rows(`SELECT observer_state, observer_attempts, observer_retry_at FROM events WHERE event_id = '${ids[0]}'`)).toEqual([
    { observer_state: 'pending', observer_attempts: 0, observer_retry_at: null },
  ])
  expect(await (await post('/observer/retry', { all: true })).json()).toEqual({ reset: 1 })
  expect(rows("SELECT count(*) AS n FROM events WHERE observer_state = 'failed'")).toEqual([{ n: 0 }])
  expect(logs).toContain(`observer retry scope=session=${session} events=1`)
  expect(logs).toContain('observer retry scope=all events=1')
})

test('the observer writing to a project rebuilds its packs', async () => {
  seedEvent(temp.store, session, { kind: 'tool_result', at: T0, promptNumber: 1, tool: { name: 'Bash', output: '12 pass', exitCode: 0 } })
  seedEvent(temp.store, session, { kind: 'turn_end', at: T0 + 10, promptNumber: 1, assistantText: 'done' })
  const runner = fakeRunner([(prompt) => JSON.stringify({
    observations: [{ type: 'discovery', title: 'Freshly observed fact', narrative: '', facts: [], files: [], evidence: { strength: 'tool-verified', sourceEventIds: [prompt.eventIds[0]] } }],
    summary: { request: 'r', learned: 'l', completed: 'c', nextSteps: 'Ship task 8' },
  })])
  start({ runnerFor: () => runner, tickMs: 60_000, resetCheckMs: 60_000 })
  await daemon!.observer!.whenIdle()

  const packs = rows('SELECT host_profile, body FROM context_packs ORDER BY host_profile') as { host_profile: string; body: string }[]
  expect(packs.map((pack) => pack.host_profile)).toEqual(['claude-code', 'default', 'opencode'])
  for (const pack of packs) {
    expect(pack.body).toContain('Freshly observed fact')
    expect(pack.body).toContain('Next steps from the latest session summary: Ship task 8')
  }
  expect(logs.some((line) => line.startsWith(`context packs rebuilt session=${session} packs=3`))).toBe(true)
})

test('a prompt with text gets related memory and a log line with counts and outcome, never the prompt', async () => {
  const other = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc-old', projectKey, cwd: projectKey, occurredAt: T0 - 10_000 })
  seedObservation(temp.store, { sessionId: other, projectKey, host: 'opencode', title: 'CSV parser drops quotes on export', at: T0 - 5_000 })
  start()
  const response = await post('/context', { host: 'claude-code', cwd: projectKey, hostSessionId: 'cc-1', channel: 'prompt', prompt: 'csv parser PROMPT-WORDS' })
  expect(response.status).toBe(200)
  const line = logs.find((entry) => entry.startsWith('context host=claude-code channel=prompt'))!
  expect(line).toMatch(/ related=\d+ semantic=off /)
  expect(logs.join('\n')).not.toContain('PROMPT-WORDS')
})

test('a prompt answer that took longer than the hook waits is returned but not recorded, so its rows are not lost', async () => {
  const other = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc-old', projectKey, cwd: projectKey, occurredAt: T0 - 10_000 })
  seedObservation(temp.store, { sessionId: other, projectKey, host: 'opencode', title: 'CSV parser drops quotes on export', at: T0 - 5_000 })
  const ticks = [0, PROMPT_SERVE_BUDGET_MS + 1]
  const handler = contextHandler({
    db: temp.store.db, projectKeyFor: () => ({ key: projectKey, kind: 'path', displayName: 'route-repo' }), log: (line) => logs.push(line),
    gate: () => true, now: () => T0, clock: () => ticks.shift() ?? PROMPT_SERVE_BUDGET_MS + 1,
  })
  const answer = await handler({ host: 'claude-code', cwd: projectKey, hostSessionId: 'cc-1', channel: 'prompt', prompt: 'csv parser quotes' })
  expect(answer.observationIds.length).toBeGreaterThan(0)
  expect(rows("SELECT id FROM injections WHERE channel = 'prompt'")).toEqual([])
  expect(logs.some((line) => line.includes('injection=skipped_late'))).toBe(true)
})

describe('update notices', () => {
  const NOTICE_HOME = (): string => temp.dataDir
  const seedState = (notified: Record<string, string> = {}): void => writeUpdateState(NOTICE_HOME(), { lastAttemptAt: 1, latestVersion: '0.2.0', checkedAt: 1, notified })
  const handler = (ticks: number[] = [], envVars: () => Record<string, string> = () => ({})) => contextHandler({
    db: temp.store.db, projectKeyFor: () => ({ key: projectKey, kind: 'path', displayName: 'route-repo' }) as never, log: () => undefined, now: () => T0,
    clock: () => ticks.shift() ?? 0, updates: { dataDir: NOTICE_HOME(), version: '0.1.0', envVars },
  })
  const ask = (h: ReturnType<typeof handler>, channel: 'session_start' | 'request' | 'prompt', host = 'claude-code') =>
    h({ host, cwd: projectKey, hostSessionId: 'cc-1', channel, ...(channel === 'prompt' ? { prompt: 'hello there' } : {}) })

  test('session start and the first request carry the notice, prompt deltas never', async () => {
    seedState()
    const h = handler()
    expect((await ask(h, 'prompt')).updateNotice).toBeUndefined()
    expect((await ask(h, 'session_start')).updateNotice).toEqual({ version: '0.2.0', channel: 'curl' })
    expect((await ask(h, 'session_start')).updateNotice).toBeUndefined()
    expect((await ask(h, 'request', 'opencode')).updateNotice?.version).toBe('0.2.0')
  })

  test('a slow answer does not mark the notice shown', async () => {
    seedState()
    const h = handler([0, 0, PROMPT_SERVE_BUDGET_MS + 50])
    const slow = await ask(h, 'session_start')
    expect(slow.updateNotice?.version).toBe('0.2.0')
    expect(readUpdateState(NOTICE_HOME()).notified).toEqual({})
    expect((await ask(h, 'session_start')).updateNotice?.version).toBe('0.2.0')
    expect(readUpdateState(NOTICE_HOME()).notified).toEqual({ 'claude-code': '0.2.0' })
  })

  test('a 500 ms answer is shown to OpenCode, which waits that long, but not to Claude Code', async () => {
    seedState()
    const h = handler([0, 0, 500, 0, 0, 500])
    expect((await ask(h, 'session_start', 'claude-code')).updateNotice?.version).toBe('0.2.0')
    expect(readUpdateState(NOTICE_HOME()).notified).toEqual({})
    expect((await ask(h, 'request', 'opencode')).updateNotice?.version).toBe('0.2.0')
    expect(readUpdateState(NOTICE_HOME()).notified).toEqual({ opencode: '0.2.0' })
    expect(shownBudgetMs('opencode')).toBe(DAEMON_ONLY_TIMEOUT_MS)
    expect(shownBudgetMs('codex')).toBe(PROMPT_SERVE_BUDGET_MS)
  })

  test('KINFOLD_NO_UPDATE_CHECK=1 gives no session-start notice and no banner', async () => {
    seedState()
    const h = handler([], () => ({ KINFOLD_NO_UPDATE_CHECK: '1' }))
    expect((await ask(h, 'session_start')).updateNotice).toBeUndefined()
    expect(readUpdateState(NOTICE_HOME()).notified).toEqual({})
    daemon = startDaemon({ dataDir: temp.dataDir, port: 0, version: '0.1.0', fallbackDrainMs: 60_000, log: () => undefined, updateCheck: { fetch: () => new Promise<Response>(() => undefined), envVars: () => ({ KINFOLD_NO_UPDATE_CHECK: '1' }) } })
    const banner = await fetch(url('/update'), { headers: { authorization: `Bearer ${token()}` } })
    expect(await banner.json()).toEqual({ notice: null })
  })

  test('GET /update answers the banner and never marks anything shown', async () => {
    writeUpdateState(NOTICE_HOME(), { lastAttemptAt: 1, latestVersion: '0.2.0', checkedAt: 1, notified: {} })
    daemon = startDaemon({ dataDir: temp.dataDir, port: 0, version: '0.1.0', fallbackDrainMs: 60_000, log: () => undefined, updateCheck: { fetch: () => new Promise<Response>(() => undefined), envVars: () => ({}) } })
    const response = await fetch(url('/update'), { headers: { authorization: `Bearer ${token()}` } })
    expect(await response.json()).toEqual({ notice: { version: '0.2.0', message: 'Kinfold 0.2.0 is available. Run `kinfold update`.' } })
    expect(readUpdateState(NOTICE_HOME()).notified).toEqual({})
    expect((await fetch(url('/update'))).status).toBe(401)
    const viaContext = (await (await post('/context', contextBody())).json()) as { updateNotice?: unknown }
    expect(viaContext.updateNotice).toEqual({ version: '0.2.0', channel: 'curl' })
  })
})
