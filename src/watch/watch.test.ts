// `kinfold watch`: one line per prompt, for every agent, read from the daemon.
// The store side picks prompts and what was sent with each; the command polls
// the authenticated route and prints. Nothing here reaches a model.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { seedObservation } from '../context/test-support'
import { type RunningDaemon, startDaemon } from '../daemon/daemon'
import { parseWatchArgs } from '../install/args'
import { type TempStore, T0, openTempStore } from '../observer/test-support'
import { recordInjection } from '../store/context-store'
import { insertPrompt, upsertProject, upsertSession } from '../store/writes'
import { type WatchEnv, formatWatchLine, runWatch } from './cli'
import { WATCH_SETTLE_MS, latestPromptId, watchRows } from './reads'

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
  const start = (await (await get('')).json()) as { cursor: number; rows: unknown[] }
  expect(start).toEqual({ cursor: latestPromptId(temp.store.db), rows: [] })

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
  expect(parseWatchArgs(['watch'])).toEqual({ ok: true, value: { command: 'watch', host: null, project: null } })
  expect(parseWatchArgs(['watch', '--host', 'claude-code', '--project=repo'])).toEqual({ ok: true, value: { command: 'watch', host: 'claude-code', project: 'repo' } })
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
  const code = await runWatch(fake.env, { command: 'watch', host: 'codex', project: 'my repo' }, { stop: stop.signal })
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
  expect(await runWatch(none.env, { command: 'watch', host: null, project: null }, {})).toBe(1)
  expect(none.out).toEqual(['kinfold watch failed: the daemon is not running (no daemon.json or daemon.token)'])
  expect(none.asked).toEqual([])

  daemon = startDaemon({ dataDir: temp.dataDir, port: 0, fallbackDrainMs: 60_000, log: () => {} })
  const old = fakeWatch([new Response('{}', { status: 404 })], new AbortController())
  expect(await runWatch(old.env, { command: 'watch', host: null, project: null }, {})).toBe(1)
  expect(old.out).toEqual(['kinfold watch failed: the running daemon is an older build without watch; run kinfold update'])

  const stop = new AbortController()
  const flaky = fakeWatch([
    Response.json({ cursor: 1, rows: [] }),
    new Error('refused'),
    new Response('{}', { status: 503 }),
    Response.json({ cursor: 2, rows: [rowAt(2, T0)] }),
    Response.json({ cursor: 2, rows: [] }),
  ], stop)
  expect(await runWatch(flaky.env, { command: 'watch', host: null, project: null }, { stop: stop.signal })).toBe(0)
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
