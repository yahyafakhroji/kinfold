// The Sessions view's reads: sessions newest first, and one session's turns
// in order, each with the prompt, what was recalled for it, the reply and
// what was saved from it. Prompt and reply are the stored text, which already
// went through the secret scan; a redaction marker is shown as it is stored.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../../../resources/tests/context/test-support'
import { type TempStore, T0, openTempStore } from '../../../resources/tests/observer/test-support'
import { recordInjection } from '../../../resources/store/context-store'
import { upsertSummary } from '../../../resources/store/observer-store'
import { PROMPT_EXPIRED_MARKER, expirePromptTexts } from '../../../resources/store/retention-store'
import { SESSIONS_PAGE, TURNS_PAGE, listSessions, sessionTurns } from '../../../resources/store/session-reads'
import { insertPrompt, setPromptReply, upsertProject, upsertSession } from '../../../resources/store/writes'
import { sessionRoute } from '../../daemon/session-routes'

const MINUTE = 60_000
let temp: TempStore
let logs: string[]
beforeEach(() => {
  temp = openTempStore('kinfold-sessions-')
  logs = []
  upsertProject(temp.store.db, { key: 'org/repo', kind: 'git-remote', displayName: 'repo' }, T0)
  upsertProject(temp.store.db, { key: 'org/other', kind: 'git-remote', displayName: 'other' }, T0)
})
afterEach(() => temp.cleanup())

const session = (host: string, id: string, at: number, projectKey = 'org/repo'): number =>
  upsertSession(temp.store.db, { host, hostSessionId: id, projectKey, cwd: '/w', occurredAt: at })
function turn(sessionId: number, number: number, at: number, prompt: string, reply?: string): void {
  insertPrompt(temp.store.db, { sessionId, promptNumber: number, text: prompt, occurredAt: at })
  if (reply !== undefined) setPromptReply(temp.store.db, sessionId, number, reply)
}
const get = (path: string) => sessionRoute('GET', new URL(`http://127.0.0.1${path}`), temp.store.db, (line) => logs.push(line))

test('sessions are listed newest first with their agent, project, start time and prompt count, a page at a time', () => {
  const a = session('claude-code', 'a', T0)
  const b = session('codex', 'b', T0 + MINUTE, 'org/other')
  const c = session('claude-code', 'c', T0 + 2 * MINUTE)
  turn(a, 1, T0 + 1, 'one')
  turn(a, 2, T0 + 2, 'two')
  turn(c, 1, T0 + 2 * MINUTE + 1, 'three')

  const all = listSessions(temp.store.db, { host: null, project: null, before: null, limit: SESSIONS_PAGE })
  expect(all.sessions.map((row) => [row.id, row.host, row.project, row.startedAt, row.prompts])).toEqual([
    [c, 'claude-code', 'repo', T0 + 2 * MINUTE, 1],
    [b, 'codex', 'other', T0 + MINUTE, 0],
    [a, 'claude-code', 'repo', T0, 2],
  ])
  expect(all.nextBefore).toBeNull()

  const first = listSessions(temp.store.db, { host: null, project: null, before: null, limit: 2 })
  expect(first.sessions.map((row) => row.id)).toEqual([c, b])
  expect(first.nextBefore).toBe(b)
  expect(listSessions(temp.store.db, { host: null, project: null, before: first.nextBefore, limit: 2 }).sessions.map((row) => row.id)).toEqual([a])
  expect(listSessions(temp.store.db, { host: 'codex', project: null, before: null, limit: 10 }).sessions.map((row) => row.id)).toEqual([b])
  expect(listSessions(temp.store.db, { host: null, project: 'org/repo', before: null, limit: 10 }).sessions.map((row) => row.id)).toEqual([c, a])
})

test("a session's turns come in order, each with its prompt, what was recalled, the reply and what was saved", () => {
  const db = temp.store.db
  const other = session('opencode', 'o', T0 - MINUTE)
  const mine = session('claude-code', 'cc', T0)
  const fresh = seedObservation(temp.store, { sessionId: other, projectKey: 'org/repo', host: 'opencode', title: 'Schema version from MIGRATIONS', at: T0 - 30_000 })
  const related = seedObservation(temp.store, { sessionId: other, projectKey: 'org/repo', host: 'opencode', title: 'Bun 1.4.4 is pinned', at: T0 - 20_000 })
  recordInjection(db, { sessionId: mine, host: 'claude-code', hostSessionId: 'cc', projectKey: 'org/repo', observationIds: [fresh, related], channel: 'session_start', tokens: 50, occurredAt: T0 })
  turn(mine, 1, T0 + MINUTE, 'how do we pin bun in CI?', 'We pin Bun through .bun-version, and CI reads it.')
  recordInjection(db, { sessionId: mine, host: 'claude-code', hostSessionId: 'cc', projectKey: 'org/repo', observationIds: [fresh, related], channel: 'prompt', tokens: 20, occurredAt: T0 + MINUTE + 5, promptNumber: 1, relatedCount: 1 })
  turn(mine, 2, T0 + 2 * MINUTE, 'and the token is <redacted type="github_token" ref="ab12"/>?')
  recordInjection(db, { sessionId: mine, host: 'claude-code', hostSessionId: 'cc', projectKey: 'org/repo', observationIds: [], channel: 'prompt', tokens: 0, occurredAt: T0 + 2 * MINUTE + 5, promptNumber: 2, heldOut: true })
  // What the observer wrote from turn 1: the side detail.
  db.query("UPDATE observations SET session_id = $s, prompt_number = 1, type = 'decision', title = 'CI pins Bun with .bun-version' WHERE id = $id")
    .run({ s: mine, id: seedObservation(temp.store, { sessionId: mine, projectKey: 'org/repo', host: 'claude-code', title: 'placeholder', at: T0 + MINUTE + 30 }) })
  upsertSummary(db, { sessionId: mine, promptNumber: 1, request: 'pin bun', learned: 'uses .bun-version', completed: 'explained', nextSteps: 'none', occurredAt: T0 + MINUTE + 40, updatedAt: T0 + MINUTE + 40 })
  db.query('UPDATE prompts SET summary_id = (SELECT id FROM summaries WHERE session_id = $s AND prompt_number = 1) WHERE session_id = $s AND prompt_number = 1').run({ s: mine })

  const detail = sessionTurns(db, mine, 0, TURNS_PAGE)!
  expect(detail.session).toMatchObject({ id: mine, host: 'claude-code', project: 'repo', prompts: 2, startMemories: 2 })
  expect(detail.nextAfter).toBeNull()
  expect(detail.turns).toHaveLength(2)
  expect(detail.turns[0]).toEqual({
    promptNumber: 1, at: T0 + MINUTE, prompt: 'how do we pin bun in CI?', reply: 'We pin Bun through .bun-version, and CI reads it.', expired: false, heldOut: false, late: false, recallKnown: true,
    recalled: [{ id: fresh, title: 'Schema version from MIGRATIONS', part: 'new' }, { id: related, title: 'Bun 1.4.4 is pinned', part: 'related' }],
    saved: [{ id: expect.any(Number), title: 'CI pins Bun with .bun-version', type: 'decision' }],
    summary: { request: 'pin bun', learned: 'uses .bun-version', completed: 'explained', nextSteps: 'none' },
  })
  // A secret shows as its marker, never its value; a held-out turn says so; no reply is null, not empty text.
  expect(detail.turns[1]).toEqual({
    promptNumber: 2, at: T0 + 2 * MINUTE, prompt: 'and the token is <redacted type="github_token" ref="ab12"/>?', reply: null, expired: false, heldOut: true, late: false, recallKnown: true,
    recalled: [], saved: [], summary: null,
  })

  // A turn from before the store tied recall to prompts: what it recalled is unknown, and the view must not say "nothing".
  turn(mine, 3, T0 + 3 * MINUTE, 'an old prompt')
  db.query("UPDATE data_settings SET value = $since WHERE key = 'impact.since'").run({ since: T0 + 10 * MINUTE })
  const old = sessionTurns(db, mine, 0, TURNS_PAGE)!.turns
  expect(old.map((entry) => entry.recallKnown)).toEqual([true, true, false])
})

test('a long session loads its turns in pages, an expired turn says so, and an unknown session is not found', () => {
  const db = temp.store.db
  const mine = session('claude-code', 'cc', T0)
  for (let n = 1; n <= TURNS_PAGE + 3; n += 1) turn(mine, n, T0 + n * 1000, `prompt ${n}`, `reply ${n}`)
  const first = sessionTurns(db, mine, 0, TURNS_PAGE)!
  expect(first.turns.map((entry) => entry.promptNumber)).toEqual(Array.from({ length: TURNS_PAGE }, (_, index) => index + 1))
  expect(first.nextAfter).toBe(TURNS_PAGE)
  const rest = sessionTurns(db, mine, first.nextAfter!, TURNS_PAGE)!
  expect(rest.turns.map((entry) => entry.promptNumber)).toEqual([TURNS_PAGE + 1, TURNS_PAGE + 2, TURNS_PAGE + 3])
  expect(rest.nextAfter).toBeNull()

  expirePromptTexts(db, T0 + 1500, T0 + 99_000, 100)
  const expired = sessionTurns(db, mine, 0, 2)!.turns
  expect(expired[0]).toMatchObject({ expired: true, prompt: PROMPT_EXPIRED_MARKER, reply: PROMPT_EXPIRED_MARKER })
  expect(expired[1]).toMatchObject({ expired: false, prompt: 'prompt 2' })
  expect(sessionTurns(db, 9999, 0, TURNS_PAGE)).toBeNull()
})

test('the routes validate their parameters, answer in pages, and log counts only', () => {
  const mine = session('claude-code', 'cc', T0)
  turn(mine, 1, T0 + 1, 'SECRET-LOOKING-PROMPT-TEXT', 'SECRET-LOOKING-REPLY')
  expect(get('/memory/observations')).toBeNull()
  const list = get('/memory/sessions?host=claude-code')!
  expect(list.status).toBe(200)
  expect((list.body as { sessions: { id: number }[] }).sessions.map((row) => row.id)).toEqual([mine])
  const turns = get(`/memory/sessions/${mine}/turns`)!
  expect(turns.status).toBe(200)
  expect((turns.body as { turns: { prompt: string }[] }).turns[0]!.prompt).toBe('SECRET-LOOKING-PROMPT-TEXT')
  expect(get('/memory/sessions/9999/turns')!.status).toBe(404)
  for (const bad of ['/memory/sessions?before=abc', '/memory/sessions?host=NOT%20A%20HOST', `/memory/sessions?project=${'x'.repeat(600)}`, '/memory/sessions?color=red', `/memory/sessions/${mine}/turns?after=-1`, `/memory/sessions/${mine}/turns?page=2`]) {
    expect(get(bad)!.status).toBe(400)
  }
  expect(sessionRoute('POST', new URL('http://127.0.0.1/memory/sessions'), temp.store.db, () => {})!.status).toBe(405)
  expect(logs.length).toBeGreaterThan(0)
  expect(logs.join('\n')).not.toContain('SECRET-LOOKING')
})
