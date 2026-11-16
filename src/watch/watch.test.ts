// `kinfold watch`: one line per prompt, for every agent, read from the daemon.
// The store side picks prompts and what was sent with each; the command polls
// the authenticated route and prints. Nothing here reaches a model.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { readUpdateState, writeUpdateState } from '../update/state'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { parseWatchArgs } from '../install/args'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { recordInjection } from '../store/context-store'
import { insertPrompt, upsertProject, upsertSession } from '../store/writes'
import { type WatchEnv, formatWatchLine, runWatch } from './cli'
import { idsInLine } from '../context/recall-line'
import { WATCH_SETTLE_MS, latestInjectionId, latestPromptId, watchRows, watchStarts } from './reads'

const MINUTE = 60_000
let temp: TempStore
let daemon: RunningDaemon | null
let claude: number
let cursorSession: number

beforeEach(() => {
  temp = openTempStore('kinfold-watch-')
  daemon = null
  const db = temp.store.db
  upsertProject(db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, T0)
  upsertProject(db, { key: 'org/other', kind: 'git-remote', displayName: 'other' }, T0)
  claude = upsertSession(db, { host: 'claude-code', hostSessionId: 'cc-1', projectKey: 'org/repo', cwd: '/w', occurredAt: T0 })
  cursorSession = upsertSession(db, { host: 'cursor', hostSessionId: 'cu-1', projectKey: 'org/other', cwd: '/o', occurredAt: T0 })
})
afterEach(async () => {
  if (daemon !== null) await daemon.stop()
  temp.cleanup()
})

const seed = (title: string): number => seedObservation(temp.store, { sessionId: cursorSession, projectKey: 'org/repo', host: 'cursor', title, at: T0 })
function prompt(sessionId: number, number: number, at: number): void {
  insertPrompt(temp.store.db, { sessionId, promptNumber: number, text: 'PROMPT-TEXT-NEVER-SHOWN', occurredAt: at })
}
function injected(ids: number[], number: number, at: number, extra: { relatedCount?: number; heldOut?: boolean } = {}): void {
  recordInjection(temp.store.db, { sessionId: claude, host: 'claude-code', hostSessionId: 'cc-1', projectKey: 'org/repo', observationIds: ids, channel: 'prompt', tokens: 5, occurredAt: at, promptNumber: number, ...extra })
}
const all = (extra: Partial<Parameters<typeof watchRows>[1]> = {}) => watchRows(temp.store.db, { afterId: 0, before: T0 + 60 * MINUTE, host: null, project: null, limit: 100, ...extra })

test('each prompt is one row with what was sent to it, by title and part; a prompt that got nothing is still a row', () => {
  const fresh = seed('New from another session')
  const related = seed('Matches the prompt')
  prompt(claude, 1, T0 + MINUTE)
  injected([fresh, related], 1, T0 + MINUTE + 20, { relatedCount: 1 })
  prompt(cursorSession, 1, T0 + 2 * MINUTE)
  prompt(claude, 2, T0 + 3 * MINUTE)
  injected([], 2, T0 + 3 * MINUTE + 20, { heldOut: true })

  const rows = all()
  expect(rows.map((row) => [row.host, row.project, row.at])).toEqual([
    ['claude-code', 'repo', T0 + MINUTE],
    ['cursor', 'other', T0 + 2 * MINUTE],
    ['claude-code', 'repo', T0 + 3 * MINUTE],
  ])
  expect(rows[0]).toMatchObject({
    ids: [fresh, related], heldOut: false,
    recalled: [{ id: fresh, title: 'New from another session', part: 'new' }, { id: related, title: 'Matches the prompt', part: 'related' }],
  })
  expect(rows[1]).toMatchObject({ ids: [], recalled: [], heldOut: false })
  expect(rows[2]).toMatchObject({ ids: [], heldOut: true })
  // Each row also carries the line ready to show and the agent's own session id, for a plugin that toasts it.
  expect(rows[0]).toMatchObject({
    hostSessionId: 'cc-1', promptNumber: 1,
    line: 'kinfold · recalled 2 (1 related, 1 new from other sessions) · #1 New from another session · #2 Matches the prompt',
  })
  expect(rows[1]).toMatchObject({ hostSessionId: 'cu-1', line: 'kinfold · nothing recalled' })
  expect(rows[2]).toMatchObject({ promptNumber: 2, line: 'kinfold · recall held out for this prompt (impact test)' })
  // Each row also carries the line ready to show and the agent's own session id, for a plugin that toasts it.
  expect(rows[0]).toMatchObject({
    hostSessionId: 'cc-1', promptNumber: 1,
    line: 'kinfold · recalled 2 (1 related, 1 new from other sessions) · #1 New from another session · #2 Matches the prompt',
  })
  expect(rows[1]).toMatchObject({ hostSessionId: 'cu-1', line: 'kinfold · nothing recalled' })
  expect(rows[2]).toMatchObject({ promptNumber: 2, line: 'kinfold · recall held out for this prompt (impact test)' })
  // A row carries ids, titles and names; never the prompt.
  expect(JSON.stringify(rows)).not.toContain('PROMPT-TEXT-NEVER-SHOWN')
  expect(latestPromptId(temp.store.db)).toBe(rows[2]!.id)
})

test('rows follow the cursor and the --host and --project filters, and a prompt too fresh to have its recall stamped waits', () => {
  prompt(claude, 1, T0 + MINUTE)
  prompt(cursorSession, 1, T0 + 2 * MINUTE)
  prompt(claude, 2, T0 + 3 * MINUTE)
  const first = all()[0]!
  expect(all({ afterId: first.id }).map((row) => row.host)).toEqual(['cursor', 'claude-code'])
  expect(all({ host: 'cursor' }).map((row) => row.host)).toEqual(['cursor'])
  expect(all({ project: 'repo' }).map((row) => row.project)).toEqual(['repo', 'repo'])
  expect(all({ project: 'org/other' }).map((row) => row.project)).toEqual(['other'])
  expect(all({ project: 'REPO' }).length).toBe(2)
  expect(all({ project: 'nope' })).toEqual([])
  // Stops at the first prompt newer than `before`, so the cursor never skips one that is still settling.
  expect(all({ before: T0 + 2 * MINUTE }).map((row) => row.at)).toEqual([T0 + MINUTE, T0 + 2 * MINUTE])
  expect(all({ limit: 1 }).length).toBe(1)
})

test('GET /watch needs the token, starts from now, and then hands over what settled', async () => {
  prompt(claude, 1, Date.now() - 10 * MINUTE)
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const token = readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
  const get = (query: string, auth = true): Promise<Response> => fetch(`http://127.0.0.1:${daemon!.port}/watch${query}`, auth ? { headers: { authorization: `Bearer ${token}` } } : {})
  expect((await get('', false)).status).toBe(401)
  const start = (await (await get('')).json()) as { cursor: number; rows: unknown[]; update: unknown }
  expect(start).toEqual({ cursor: latestPromptId(temp.store.db), rows: [], update: null })

  prompt(claude, 2, Date.now() - WATCH_SETTLE_MS - 500)
  prompt(claude, 3, Date.now())
  const next = (await (await get(`?after=${start.cursor}`)).json()) as { cursor: number; rows: { host: string; project: string }[] }
  expect(next.rows).toHaveLength(1)
  expect(next.rows[0]).toMatchObject({ host: 'claude-code', project: 'repo' })
  expect(next.cursor).toBe(start.cursor + 1)
  expect((await get('?after=abc')).status).toBe(400)
  expect((await get(`?after=0&host=${'x'.repeat(200)}`)).status).toBe(400)
  expect((await fetch(`http://127.0.0.1:${daemon!.port}/watch`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(405)
})

// --- the command ---

test('watch takes --host and --project, and nothing else', () => {
  expect(parseWatchArgs(['status'])).toBeNull()
  expect(parseWatchArgs(['watch'])).toEqual({ ok: true, value: { command: 'watch', host: null, project: null, debug: false, json: false } })
  expect(parseWatchArgs(['watch', '--host', 'claude-code', '--project=repo'])).toEqual({ ok: true, value: { command: 'watch', host: 'claude-code', project: 'repo', debug: false, json: false } })
  expect(parseWatchArgs(['watch', '--host', 'not-an-agent'])?.ok).toBe(false)
  expect(parseWatchArgs(['watch', '--host'])?.ok).toBe(false)
  expect(parseWatchArgs(['watch', '--follow'])?.ok).toBe(false)
})

const hhmm = (at: number): string => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

test('a line names the time, the agent, the project and what was recalled', () => {
  const at = T0 + MINUTE
  const row = { id: 1, at, host: 'claude-code', project: 'repo', ids: [7, 9], heldOut: false, recalled: [{ id: 7, title: 'Bun is pinned', part: 'new' as const }, { id: 9, title: 'Service selection', part: 'related' as const }] }
  expect(formatWatchLine(row)).toBe(`${hhmm(at)}  claude-code · repo · recalled 2 (1 related, 1 new from other sessions) · #7 Bun is pinned · #9 Service selection`)
  expect(formatWatchLine({ ...row, ids: [], recalled: [] })).toBe(`${hhmm(at)}  claude-code · repo · nothing recalled`)
  expect(formatWatchLine({ ...row, late: true })).toBe(`${hhmm(at)}  claude-code · repo · too late to show, not counted as sent · recalled 2 (1 related, 1 new from other sessions) · #7 Bun is pinned · #9 Service selection`)
  expect(formatWatchLine({ ...row, ids: [], recalled: [], heldOut: true })).toBe(`${hhmm(at)}  claude-code · repo · recall held out for this prompt (impact test)`)
  // A project name is another machine's text too.
  expect(formatWatchLine({ ...row, project: 'evil\u001b[31m\nname', ids: [], recalled: [] })).toBe(`${hhmm(at)}  claude-code · evil [31m name · nothing recalled`)
})

interface Fake {
  env: WatchEnv
  out: string[]
  asked: string[]
}

/** A daemon that answers each poll from a script; when the script runs out, the watch is stopped. */
function fakeWatch(answers: (Response | Error)[], stop: AbortController): Fake {
  const out: string[] = []
  const asked: string[] = []
  const env: WatchEnv = {
    dataDir: temp.dataDir,
    out: (line) => out.push(line),
    sleep: async () => {},
    fetch: async (url) => {
      asked.push(String(url).replace(/^http:\/\/127\.0\.0\.1:\d+/, ''))
      const answer = answers.shift()
      if (answers.length === 0) stop.abort()
      if (answer === undefined) return Response.json({ cursor: 0, rows: [] })
      if (answer instanceof Error) throw answer
      return answer
    },
  }
  return { env, out, asked }
}

const rowAt = (id: number, at: number) => ({ id, at, host: 'codex', project: 'repo', ids: [], recalled: [], heldOut: false })

test('the command starts from now, prints each new prompt once, keeps the filters on every poll, and Ctrl-C ends it with 0', async () => {
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const stop = new AbortController()
  const fake = fakeWatch([
    Response.json({ cursor: 4, rows: [] }),
    Response.json({ cursor: 6, rows: [rowAt(5, T0), rowAt(6, T0 + MINUTE)] }),
    Response.json({ cursor: 6, rows: [] }),
  ], stop)
  const code = await runWatch(fake.env, { command: 'watch', host: 'codex', project: 'my repo', debug: false, json: false }, { stop: stop.signal })
  expect(code).toBe(0)
  expect(fake.asked).toEqual(['/watch?host=codex&project=my+repo', '/watch?after=4&host=codex&project=my+repo', '/watch?after=6&host=codex&project=my+repo'])
  expect(fake.out).toEqual([
    'watching codex in my repo; one line per prompt, Ctrl-C to stop',
    `${hhmm(T0)}  codex · repo · nothing recalled`,
    `${hhmm(T0 + MINUTE)}  codex · repo · nothing recalled`,
  ])
})

test('with no daemon the command says so and fails; a daemon that stops answering mid-watch is waited for, said once', async () => {
  const none = fakeWatch([], new AbortController())
  expect(await runWatch(none.env, { command: 'watch', host: null, project: null, debug: false, json: false }, {})).toBe(1)
  expect(none.out).toEqual(['kinfold watch failed: the daemon is not running (no daemon.json or daemon.token)'])
  expect(none.asked).toEqual([])

  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const old = fakeWatch([new Response('{}', { status: 404 })], new AbortController())
  expect(await runWatch(old.env, { command: 'watch', host: null, project: null, debug: false, json: false }, {})).toBe(1)
  expect(old.out).toEqual(['kinfold watch failed: the running daemon is an older build without watch; run kinfold update'])

  const stop = new AbortController()
  const flaky = fakeWatch([
    Response.json({ cursor: 1, rows: [] }),
    new Error('refused'),
    new Response('{}', { status: 503 }),
    Response.json({ cursor: 2, rows: [rowAt(2, T0)] }),
    Response.json({ cursor: 2, rows: [] }),
  ], stop)
  expect(await runWatch(flaky.env, { command: 'watch', host: null, project: null, debug: false, json: false }, { stop: stop.signal })).toBe(0)
  expect(flaky.out).toEqual([
    'watching every agent; one line per prompt, Ctrl-C to stop',
    'the daemon is not answering; waiting for it',
    'the daemon is back',
    `${hhmm(T0)}  codex · repo · nothing recalled`,
  ])
  expect(flaky.asked.slice(1)).toEqual(['/watch?after=1', '/watch?after=1', '/watch?after=1', '/watch?after=2'])
})

test('a watcher polling once a second does not count as activity, so it never keeps an update waiting', async () => {
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const token = readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
  const get = (path: string): Promise<Response> => fetch(`http://127.0.0.1:${daemon!.port}${path}`, { headers: { authorization: `Bearer ${token}` } })
  const quiet = async (): Promise<number> => ((await (await get('/update/quiet')).json()) as { quietForMs: number }).quietForMs
  await get('/sessions')
  await new Promise((resolve) => setTimeout(resolve, 120))
  const before = await quiet()
  expect(before).toBeGreaterThanOrEqual(100)
  expect((await get('/watch')).status).toBe(200)
  expect(await quiet()).toBeGreaterThanOrEqual(before)
  // Anything else still counts.
  await get('/sessions')
  expect(await quiet()).toBeLessThan(before)
})

// --- session starts: the first-screen list a plugin toasts ---

function pack(host: string, hostSessionId: string, ids: number[], at: number, channel: 'session_start' | 'request' | 'prompt' = 'request', projectKey = 'org/repo'): number {
  return recordInjection(temp.store.db, { sessionId: null, host, hostSessionId, projectKey, observationIds: ids, channel, tokens: 9, occurredAt: at, promptNumber: channel === 'prompt' ? 1 : null })
}
const starts = (extra: Partial<Parameters<typeof watchStarts>[1]> = {}) => watchStarts(temp.store.db, { afterId: 0, host: null, project: null, limit: 100, now: T0 + 3 * 60 * MINUTE, ...extra })

test('a session start is one row: the first pack a session was sent, as the list a hook would show', () => {
  const older = seedObservation(temp.store, { sessionId: cursorSession, projectKey: 'org/repo', host: 'cursor', title: 'Older memory', at: T0 - 26 * 60 * MINUTE })
  const newer = seed('CI pins Bun with .bun-version')
  upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'ses_1', projectKey: 'org/repo', cwd: '/w', occurredAt: T0 + MINUTE })
  const first = pack('opencode', 'ses_1', [older, newer], T0 + MINUTE)
  // The same session asking again (after a compaction, say) and its prompt deltas are not session starts.
  pack('opencode', 'ses_1', [older, newer], T0 + 30 * MINUTE)
  pack('opencode', 'ses_1', [newer], T0 + 31 * MINUTE, 'prompt')
  const hook = pack('claude-code', 'cc-1', [newer], T0 + 40 * MINUTE, 'session_start')

  const rows = starts()
  expect(rows.map((row) => [row.id, row.host, row.hostSessionId, row.project, row.at])).toEqual([
    [first, 'opencode', 'ses_1', 'repo', T0 + MINUTE],
    [hook, 'claude-code', 'cc-1', 'repo', T0 + 40 * MINUTE],
  ])
  expect(rows[0]!.ids).toEqual([older, newer])
  expect(rows[0]!.list).toBe([
    'kinfold · repo · 2 memories · last session 3h ago',
    `  #${newer} CI pins Bun with .bun-version (3h)`,
    `  #${older} Older memory (1d)`,
  ].join('\n'))
  // The list names the ids the pack carried and no other.
  expect(idsInLine(rows[0]!.list).sort()).toEqual([older, newer].sort())
  expect(starts({ afterId: first }).map((row) => row.id)).toEqual([hook])
  expect(starts({ host: 'opencode' }).map((row) => row.host)).toEqual(['opencode'])
  expect(starts({ project: 'REPO' }).length).toBe(2)
  expect(starts({ project: 'other' })).toEqual([])
  expect(starts({ limit: 1 }).length).toBe(1)
  expect(latestInjectionId(temp.store.db)).toBe(hook)
})

test('GET /watch hands over session starts only to a watcher that asks, from now on', async () => {
  const memory = seed('In the pack')
  const before = pack('opencode', 'ses_old', [memory], Date.now() - 10 * MINUTE)
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const token = readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
  const get = async (query: string): Promise<{ status: number; body: Record<string, any> }> => {
    const response = await fetch(`http://127.0.0.1:${daemon!.port}/watch${query}`, { headers: { authorization: `Bearer ${token}` } })
    return { status: response.status, body: (await response.json()) as Record<string, any> }
  }
  // A watcher that does not ask (kinfold watch, an older plugin) gets what it always got, and the update line every watcher gets.
  expect(Object.keys((await get('')).body).sort()).toEqual(['cursor', 'rows', 'update'])
  expect(Object.keys((await get('?after=0')).body).sort()).toEqual(['cursor', 'rows', 'update'])

  const first = (await get('?startsAfter=now')).body
  expect(first).toMatchObject({ rows: [], starts: [], startCursor: before })
  const fresh = pack('opencode', 'ses_new', [memory], Date.now())
  pack('cursor', 'cu-9', [memory], Date.now(), 'session_start')
  const next = (await get(`?after=${first.cursor}&startsAfter=${first.startCursor}&host=opencode`)).body
  expect(next.starts).toHaveLength(1)
  expect(next.starts[0]).toMatchObject({ id: fresh, host: 'opencode', hostSessionId: 'ses_new', project: 'repo', ids: [memory] })
  expect(String(next.starts[0].list).split('\n')[0]).toMatch(/^kinfold · repo · 1 memory/)
  // The cursor passes the other agent's row too, so it is not looked at again.
  expect(next.startCursor).toBe(latestInjectionId(temp.store.db))
  expect((await get(`?after=${first.cursor}&startsAfter=${next.startCursor}`)).body.starts).toEqual([])
  for (const bad of ['abc', '-1', '1.5', '']) expect((await get(`?startsAfter=${bad}`)).status).toBe(400)
})

test('a watcher whose cursors are past the store (a restore put a smaller one in place) starts again from now', async () => {
  const memory = seed('In the pack')
  pack('opencode', 'ses_a', [memory], Date.now() - 10 * MINUTE)
  prompt(claude, 1, Date.now() - 10 * MINUTE)
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const token = readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
  const get = async (query: string): Promise<Record<string, any>> =>
    (await (await fetch(`http://127.0.0.1:${daemon!.port}/watch${query}`, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, any>
  const far = await get('?after=500&startsAfter=900')
  expect(far).toMatchObject({ cursor: latestPromptId(temp.store.db), startCursor: latestInjectionId(temp.store.db), rows: [], starts: [] })
  const fresh = pack('opencode', 'ses_b', [memory], Date.now())
  const next = await get(`?after=${far.cursor}&startsAfter=${far.startCursor}`)
  expect(next.starts.map((row: { id: number }) => row.id)).toEqual([fresh])
})

test('the watch prints an update notice once, on its own line, and again only for another one', async () => {
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const stop = new AbortController()
  const update = { version: '0.6.0', message: 'Kinfold 0.6.0 is available. Run `kinfold update`.' }
  const fake = fakeWatch([
    Response.json({ cursor: 4, rows: [], update }),
    Response.json({ cursor: 4, rows: [], update }),
    Response.json({ cursor: 5, rows: [rowAt(5, T0)], update: { version: '0.7.0', message: 'Kinfold 0.7.0 is ready' } }),
    Response.json({ cursor: 5, rows: [], update: null }),
  ], stop)
  expect(await runWatch(fake.env, { command: 'watch', host: null, project: null, debug: false, json: false }, { stop: stop.signal })).toBe(0)
  expect(fake.out).toEqual([
    'watching every agent; one line per prompt, Ctrl-C to stop',
    'Kinfold 0.6.0 is available. Run `kinfold update`.',
    'Kinfold 0.7.0 is ready',
    `${hhmm(T0)}  codex · repo · nothing recalled`,
  ])
})

test('GET /watch carries the update the user is owed, without using up a notice', async () => {
  writeFileSync(join(temp.dataDir, 'install.json'), JSON.stringify({ channel: 'curl', updateCheck: true, autoUpdate: true, firstInstalledAt: 1 }))
  writeUpdateState(temp.dataDir, { lastAttemptAt: T0, latestVersion: '0.6.0', checkedAt: T0, notified: {} })
  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {}, version: '0.5.0', updateCheck: { fetch: () => new Promise<Response>(() => undefined), envVars: () => ({}) } })
  const token = readFileSync(join(temp.dataDir, 'daemon.token'), 'utf8').trim()
  const body = (await (await fetch(`http://127.0.0.1:${daemon.port}/watch`, { headers: { authorization: `Bearer ${token}` } })).json()) as { update: unknown }
  expect(body.update).toEqual({ version: '0.6.0', message: 'Kinfold 0.6.0 is available. Run `kinfold update`.' })
  expect(readUpdateState(temp.dataDir).notified).toEqual({})
})
