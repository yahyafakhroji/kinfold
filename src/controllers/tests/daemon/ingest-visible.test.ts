// What ingest keeps for the Sessions view: the agent's reply next to its
// prompt, and each prompt-time injection tied to the prompt it answered.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FAKE_SECRETS } from '../../../../test/fixtures/secrets'
import { captureEvent } from '../../../resources/capture/capture'
import { DEFAULT_MAX_FIELD_CHARS } from '../../../resources/capture/prepare'
import { type NormalizedEvent, SCHEMA_VERSION } from '../../../system/contract/event'
import { ulid } from '../../../system/contract/ulid'
import { recordInjection } from '../../../resources/store/context-store'
import { type Store, openStore } from '../../../resources/store/db'
import { drainSpool } from '../../daemon/ingest'

const HMAC = 'test-key'
let root: string
let spoolDir: string
let store: Store

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kinfold-ingest-visible-'))
  spoolDir = join(root, 'spool')
  store = openStore(join(root, 'data'))
})
afterEach(() => {
  store.db.close()
  rmSync(root, { recursive: true, force: true })
})

let clock = 1_792_841_878_000
function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  clock += 1_000
  return { schemaVersion: SCHEMA_VERSION, eventId: ulid(clock), host: 'claude-code', hostSessionId: 'session-1', kind: 'session_start', occurredAt: clock, cwd: '/work/repo', ...overrides }
}
const prompt = (text: string): NormalizedEvent => event({ kind: 'user_prompt', promptText: text })
const stop = (text?: string): NormalizedEvent => event({ kind: 'turn_end', ...(text !== undefined ? { assistantText: text } : {}) })

const drain = () => {
  const result = drainSpool(store.db, { spoolDir, hmacKey: HMAC, projectKeyFor: () => ({ key: 'org/repo', kind: 'git-remote', displayName: 'repo' }) })
  expect(result.error).toBeUndefined()
  return result
}
const spool = (...events: NormalizedEvent[]): void => {
  for (const item of events) captureEvent(item, { spoolDir, hmacKey: HMAC })
}
const replies = (): { n: number; reply: string | null }[] =>
  store.db.query<{ n: number; reply: string | null }, []>('SELECT prompt_number AS n, reply_text AS reply FROM prompts ORDER BY prompt_number').all()

test("turn_end's reply is kept with its prompt", () => {
  spool(event(), prompt('how do we pin bun in CI?'), stop('We pin Bun through .bun-version.'), prompt('and on Windows?'), stop('The same file.'))
  drain()
  expect(replies()).toEqual([{ n: 1, reply: 'We pin Bun through .bun-version.' }, { n: 2, reply: 'The same file.' }])
})

test('when Stop fires more than once for a prompt the latest reply replaces the earlier one', () => {
  spool(event(), prompt('p'), stop('first answer'))
  drain()
  expect(replies()).toEqual([{ n: 1, reply: 'first answer' }])
  spool(stop('final answer'))
  drain()
  expect(replies()).toEqual([{ n: 1, reply: 'final answer' }])
  // A Stop with no text (a hook that sent none) keeps what is there.
  spool(stop())
  drain()
  expect(replies()).toEqual([{ n: 1, reply: 'final answer' }])
})

test('a turn_end with no prompt before it is stored as an event and touches nothing else', () => {
  spool(event(), stop('reply to nothing'))
  expect(drain().inserted).toBe(2)
  expect(replies()).toEqual([])
})

test('the same turn_end drained twice writes the reply once', () => {
  const end = stop('once')
  spool(event(), prompt('p'))
  drain()
  spool(end)
  drain()
  store.db.run("UPDATE prompts SET reply_text = 'changed by hand'")
  spool(end)
  expect(drain().duplicates).toBe(1)
  expect(replies()).toEqual([{ n: 1, reply: 'changed by hand' }])
})

test('a secret in the reply is stored as its redaction marker, and a long reply keeps the capture cap', () => {
  spool(event(), prompt('p'), stop(`the key is ${FAKE_SECRETS.aws} ok`))
  drain()
  const reply = replies()[0]!.reply!
  expect(reply).not.toContain(FAKE_SECRETS.aws)
  expect(reply).toMatch(/^the key is <redacted type="aws_access_key" ref="[^"]+"\/> ok$/)

  spool(prompt('q'), stop('x'.repeat(DEFAULT_MAX_FIELD_CHARS * 2)))
  drain()
  const long = replies()[1]!.reply!
  // The capture's cap plus its truncation marker, not the whole text.
  expect(long.length).toBeLessThan(DEFAULT_MAX_FIELD_CHARS + 512)
  expect(long.length).toBeGreaterThanOrEqual(DEFAULT_MAX_FIELD_CHARS)
})

test('a prompt-time injection written before its prompt is drained is given that prompt, even in one batch of several', () => {
  const start = event()
  const first = prompt('one')
  const second = prompt('two')
  spool(start)
  drain()
  const inject = (at: number): number => recordInjection(store.db, {
    sessionId: 1, host: 'claude-code', hostSessionId: 'session-1', projectKey: 'org/repo', observationIds: [], channel: 'prompt', tokens: 1, occurredAt: at, heldOut: true,
  })
  // Each hook asked a few ms after it spooled its prompt; neither prompt is in the store yet.
  inject(first.occurredAt + 20)
  inject(second.occurredAt + 20)
  spool(first, second)
  drain()
  expect(store.db.query('SELECT prompt_number AS n FROM injections ORDER BY id').all()).toEqual([{ n: 1 }, { n: 2 }])
})

test("another session's injections are left alone", () => {
  spool(event(), event({ hostSessionId: 'session-2' }))
  drain()
  const mine = prompt('one')
  recordInjection(store.db, { sessionId: 2, host: 'claude-code', hostSessionId: 'session-2', projectKey: 'org/repo', observationIds: [4], channel: 'prompt', tokens: 1, occurredAt: mine.occurredAt + 20 })
  spool(mine)
  drain()
  expect(store.db.query('SELECT prompt_number AS n FROM injections').all()).toEqual([{ n: null }])
})
