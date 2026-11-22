// What POST /context adds for the user's screen, and the opt-in holdout. The
// display block only names ids the answer already carries; a held-out prompt
// sends nothing, says so, and leaves the delta's cursor where it was.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { seedObservation } from '../../../resources/tests/context/test-support'
import type { ContextRequest } from '../../../resources/context/types'
import { type TempStore, T0, openTempStore } from '../../../resources/tests/observer/test-support'
import { recordInjection, stampInjectionPrompts } from '../../../resources/store/context-store'
import { insertPrompt, upsertProject, upsertSession } from '../../../resources/store/writes'
import { HOLDOUT_HOSTS, HOLDOUT_RATE, type ContextRouteDeps, contextHandler } from '../../daemon/context-route'

const MINUTE = 60_000
let temp: TempStore
let projectKey: string
let mine: number
let other: number
let logs: string[]

beforeEach(() => {
  temp = openTempStore('kinfold-context-display-')
  projectKey = temp.root
  logs = []
  upsertProject(temp.store.db, { key: projectKey, kind: 'path', displayName: 'display-repo' }, T0)
  mine = upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'cc-1', projectKey, cwd: projectKey, occurredAt: T0 })
  other = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'oc-1', projectKey, cwd: projectKey, occurredAt: T0 - 2 * 60 * MINUTE })
})
afterEach(() => temp.cleanup())

const seed = (title: string, at: number): number => seedObservation(temp.store, { sessionId: other, projectKey, host: 'opencode', title, at })
const handler = (now: number, extra: Partial<ContextRouteDeps> = {}) =>
  contextHandler({ db: temp.store.db, projectKeyFor: () => ({ key: projectKey, kind: 'path', displayName: 'display-repo' }), log: (line) => logs.push(line), now: () => now, ...extra })
const request = (channel: ContextRequest['channel'], extra: Partial<ContextRequest> = {}): ContextRequest => ({ host: 'claude-code', cwd: projectKey, hostSessionId: 'cc-1', channel, ...extra })
const injections = () => temp.store.db.query(
  'SELECT channel, observation_ids AS ids, tokens, prompt_number AS promptNumber, held_out AS heldOut, related_count AS relatedCount FROM injections ORDER BY id',
).all() as { channel: string; ids: string; tokens: number; promptNumber: number | null; heldOut: number; relatedCount: number }[]

test('session start carries the header and the newest eight of the pack, and nothing the pack lacks', async () => {
  const ids = Array.from({ length: 11 }, (_, index) => seed(`Memory ${index}`, T0 - (20 - index) * MINUTE))
  const answer = await handler(T0 + MINUTE)(request('session_start'))
  const screen = answer.display?.firstScreen
  expect(screen).toBeDefined()
  expect(screen!.project).toBe('display-repo')
  expect(screen!.total).toBe(11)
  // The other session's last event, not this one's.
  expect(screen!.lastSessionAt).toBe(T0 - 2 * 60 * MINUTE)
  expect(screen!.rows.map((row) => row.id)).toEqual([...ids].reverse().slice(0, 8))
  expect(screen!.rows[0]).toEqual({ id: ids.at(-1)!, title: 'Memory 10', occurredAt: T0 - 10 * MINUTE })
  expect(screen!.rows.every((row) => answer.observationIds.includes(row.id))).toBe(true)
  // The model's text is the pack and nothing more.
  expect(answer.text).not.toContain('kinfold ·')
})

test('a display-only ask sends no memory and records nothing, but still has the header', async () => {
  seed('Would be in the pack', T0 - MINUTE)
  const answer = await handler(T0 + MINUTE)(request('session_start', { host: 'junie', hostSessionId: 'j-1', displayOnly: true }))
  expect(answer).toMatchObject({ text: '', observationIds: [], tokens: 0 })
  expect(answer.display?.firstScreen).toMatchObject({ project: 'display-repo', total: 1, rows: [] })
  expect(injections()).toEqual([])
})

test('a prompt answer names each id it carries, with the half that sent it, and records how many were related', async () => {
  const old = seed('Bun version pinned through the bun-version file', T0 - 30 * MINUTE)
  recordInjection(temp.store.db, { sessionId: mine, host: 'claude-code', hostSessionId: 'cc-1', projectKey, observationIds: [], channel: 'session_start', tokens: 5, occurredAt: T0 })
  const fresh = seed('Written by another session just now', T0 + MINUTE)
  const answer = await handler(T0 + 2 * MINUTE, { gate: () => true })(request('prompt', { prompt: 'how is the bun version pinned in the bun-version file' }))
  expect(answer.observationIds).toEqual([fresh, old])
  expect(answer.display?.recalled).toEqual([
    { id: fresh, title: 'Written by another session just now', part: 'new' },
    { id: old, title: 'Bun version pinned through the bun-version file', part: 'related' },
  ])
  expect(answer.display?.heldOut).toBeUndefined()
  expect(injections().at(-1)).toMatchObject({ channel: 'prompt', ids: JSON.stringify([fresh, old]), relatedCount: 1, heldOut: 0 })
})

test('with the impact test on, a picked Claude Code prompt gets nothing, says so, and the memory arrives with the next prompt', async () => {
  // The session has received nothing yet: the held-out row is its first on the prompt channel.
  const fresh = seed('Learned while this session ran', T0 + MINUTE)
  let pick = true
  const holdout = { on: () => true, pick: () => pick }
  const held = await handler(T0 + 2 * MINUTE, { holdout })(request('prompt', { prompt: 'anything' }))
  expect(held).toMatchObject({ text: '', observationIds: [], tokens: 0, display: { heldOut: true } })
  expect(held.relatedText).toBeUndefined()
  expect(injections()).toEqual([{ channel: 'prompt', ids: '[]', tokens: 0, promptNumber: null, heldOut: 1, relatedCount: 0 }])
  expect(logs.some((line) => line.includes('held_out=1'))).toBe(true)

  // The cursor did not move, and the held-out row is not when the session "first received memory".
  pick = false
  const next = await handler(T0 + 3 * MINUTE, { holdout })(request('prompt', { prompt: 'anything' }))
  expect(next.observationIds).toEqual([fresh])
  expect(next.display).toEqual({ recalled: [{ id: fresh, title: 'Learned while this session ran', part: 'new' }] })
})

test('the holdout never touches an agent whose usage cannot be read, nor anyone while it is off', async () => {
  expect(HOLDOUT_HOSTS).toEqual(['claude-code'])
  expect(HOLDOUT_RATE).toBe(0.1)
  upsertSession(temp.store.db, { host: 'codex', hostSessionId: 'cx-1', projectKey, cwd: projectKey, occurredAt: T0 })
  const fresh = seed('For everyone', T0 + MINUTE)
  let asked = 0
  const always = { on: () => true, pick: () => { asked += 1; return true } }
  const codex = await handler(T0 + 2 * MINUTE, { holdout: always })(request('prompt', { host: 'codex', hostSessionId: 'cx-1', prompt: 'p' }))
  expect(codex.observationIds).toEqual([fresh])
  expect(codex.display?.heldOut).toBeUndefined()
  expect(asked).toBe(0)

  const off = await handler(T0 + 2 * MINUTE, { holdout: { on: () => false, pick: always.pick } })(request('prompt', { prompt: 'p' }))
  expect(off.observationIds).toEqual([fresh])
  expect(asked).toBe(0)
  // Session start is never held out.
  const start = await handler(T0 + 2 * MINUTE, { holdout: always })(request('session_start', { hostSessionId: 'cc-2' }))
  expect(start.observationIds).toEqual([fresh])
  expect(asked).toBe(0)
})

test('about one prompt in ten is held out when nothing else decides', async () => {
  const random = Math.random
  const draws = [0.05, 0.5, 0.099, 0.1]
  Math.random = () => draws.shift() ?? 1
  try {
    const run = handler(T0 + MINUTE, { holdout: { on: () => true } })
    const outcomes: boolean[] = []
    for (let index = 0; index < 4; index += 1) outcomes.push((await run(request('prompt', { prompt: 'p' }))).display?.heldOut === true)
    expect(outcomes).toEqual([true, false, true, false])
  } finally {
    Math.random = random
  }
})

test('a prompt-time row finds its prompt whichever lands first, the injection or the prompt', async () => {
  const db = temp.store.db
  // The hook asked before the drain: no prompt row yet, so no number.
  seed('First', T0 + MINUTE)
  await handler(T0 + 2 * MINUTE)(request('prompt', { prompt: 'p' }))
  expect(injections().at(-1)!.promptNumber).toBeNull()
  insertPrompt(db, { sessionId: mine, promptNumber: 1, text: 'p', occurredAt: T0 + 2 * MINUTE - 5 })
  expect(stampInjectionPrompts(db, { sessionId: mine, host: 'claude-code', hostSessionId: 'cc-1', promptNumber: 1, occurredAt: T0 + 2 * MINUTE - 5 })).toBe(1)
  expect(injections().at(-1)!.promptNumber).toBe(1)

  // The drain won: the prompt is already there when the injection is written.
  insertPrompt(db, { sessionId: mine, promptNumber: 2, text: 'q', occurredAt: T0 + 4 * MINUTE - 5 })
  seed('Second', T0 + 3 * MINUTE)
  await handler(T0 + 4 * MINUTE)(request('prompt', { prompt: 'q' }))
  expect(injections().at(-1)!.promptNumber).toBe(2)

  // Written against the prompt before its own (not ingested yet), then claimed by the later prompt; prompt 2's row stays.
  seed('Third', T0 + 5 * MINUTE)
  await handler(T0 + 6 * MINUTE)(request('prompt', { prompt: 'r' }))
  expect(injections().at(-1)!.promptNumber).toBe(2)
  insertPrompt(db, { sessionId: mine, promptNumber: 3, text: 'r', occurredAt: T0 + 6 * MINUTE - 5 })
  stampInjectionPrompts(db, { sessionId: mine, host: 'claude-code', hostSessionId: 'cc-1', promptNumber: 3, occurredAt: T0 + 6 * MINUTE - 5 })
  expect(injections().map((row) => row.promptNumber)).toEqual([1, 2, 3])
  // A session-start row is never given a prompt.
  await handler(T0 + 7 * MINUTE)(request('session_start'))
  expect(injections().at(-1)).toMatchObject({ channel: 'session_start', promptNumber: null })
})
