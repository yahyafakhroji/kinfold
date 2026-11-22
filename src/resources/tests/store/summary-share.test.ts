import { afterEach, beforeEach, expect, test } from 'bun:test'
import { T0, type TempStore, openTempStore } from '../observer/test-support'
import { expirePromptTexts } from './retention-store'
import { normalizePromptText, promptTextHash, repeatedPromptNumbers, writeSharedSummary } from './summary-share'
import { insertPrompt, upsertProject, upsertSession } from './writes'

let temp: TempStore
beforeEach(() => {
  temp = openTempStore('sam-share-')
})
afterEach(() => temp.cleanup())

const NOTICE = 'Worker P1-X finished.\nRead its report.'
const summary = (request: string) => ({ request, learned: 'l', completed: 'c', nextSteps: 'n' })

function session(projectKey: string, hostSessionId: string): number {
  upsertProject(temp.store.db, { key: projectKey, kind: 'git-remote', displayName: projectKey }, T0)
  return upsertSession(temp.store.db, { host: 'claude-code', hostSessionId, projectKey, cwd: '/w', occurredAt: T0 })
}

function prompt(sessionId: number, promptNumber: number, text: string, at: number): void {
  insertPrompt(temp.store.db, { sessionId, promptNumber, text, occurredAt: at })
}

const write = (sessionId: number, projectKey: string, promptNumber: number, request: string | null, at: number) =>
  writeSharedSummary(temp.store.db, { sessionId, projectKey, promptNumber, summary: request === null ? null : summary(request), occurredAt: at, now: at })

const summaries = () => temp.store.db.query<{ id: number; request: string; repeatCount: number; lastSeenAt: number }, []>(
  'SELECT id, request, repeat_count AS repeatCount, last_seen_at AS lastSeenAt FROM summaries ORDER BY id').all()
const pointers = () => temp.store.db.query<{ n: number; s: number | null }, []>('SELECT prompt_number AS n, summary_id AS s FROM prompts ORDER BY id').all()

test('normalization trims and collapses whitespace; the hash is stable, hex, and null for blank text', () => {
  expect(normalizePromptText('  a\n\tb   c ')).toBe('a b c')
  expect(promptTextHash('a b c')).toBe(promptTextHash('  a\n\tb   c '))
  expect(promptTextHash('a b c')).toMatch(/^[0-9a-f]{64}$/)
  expect(promptTextHash('a b d')).not.toBe(promptTextHash('a b c'))
  expect(promptTextHash('A b c')).not.toBe(promptTextHash('a b c'))
  expect(promptTextHash(' \n ')).toBeNull()
})

test('a second identical prompt reuses the summary, bumps count and last seen, and adds no row; its text is dropped', () => {
  const s1 = session('org/repo', 'one')
  const s2 = session('org/repo', 'two')
  prompt(s1, 1, NOTICE, T0)
  prompt(s2, 4, `  ${NOTICE.replace('\n', '   ')} `, T0 + 1_000)
  expect(write(s1, 'org/repo', 1, 'first', T0 + 10)).toBe('own')
  expect(write(s2, 'org/repo', 4, 'second', T0 + 1_010)).toBe('shared')
  expect(summaries()).toEqual([{ id: 1, request: 'first', repeatCount: 2, lastSeenAt: T0 + 1_000 }])
  expect(pointers()).toEqual([{ n: 1, s: 1 }, { n: 4, s: 1 }])
})

test('a repeat with summary null still attaches, so the observer may skip it', () => {
  const s1 = session('org/repo', 'one')
  prompt(s1, 1, NOTICE, T0)
  prompt(s1, 2, NOTICE, T0 + 5)
  write(s1, 'org/repo', 1, 'first', T0 + 1)
  expect(write(s1, 'org/repo', 2, null, T0 + 6)).toBe('shared')
  expect(summaries().map((row) => row.repeatCount)).toEqual([2])
  expect(write(s1, 'org/repo', 2, null, T0 + 7)).toBe('shared')
  expect(summaries().map((row) => row.repeatCount)).toEqual([2])
})

test('a different project or different text gets its own row; null on a new prompt writes nothing', () => {
  const a = session('org/repo', 'a')
  const b = session('org/other', 'b')
  prompt(a, 1, NOTICE, T0)
  prompt(b, 1, NOTICE, T0 + 1)
  prompt(a, 2, `${NOTICE} again`, T0 + 2)
  prompt(a, 3, 'new prompt', T0 + 3)
  expect(write(a, 'org/repo', 1, 'a1', T0)).toBe('own')
  expect(write(b, 'org/other', 1, 'b1', T0 + 1)).toBe('own')
  expect(write(a, 'org/repo', 2, 'a2', T0 + 2)).toBe('own')
  expect(write(a, 'org/repo', 3, null, T0 + 3)).toBe('none')
  expect(summaries().map((row) => [row.request, row.repeatCount])).toEqual([['a1', 1], ['b1', 1], ['a2', 1]])
})

test('a re-run of the first prompt updates the shared row with the empty-keeps-old rule', () => {
  const s1 = session('org/repo', 'one')
  prompt(s1, 1, NOTICE, T0)
  prompt(s1, 2, NOTICE, T0 + 5)
  write(s1, 'org/repo', 1, 'first', T0 + 1)
  write(s1, 'org/repo', 2, 'ignored', T0 + 6)
  expect(write(s1, 'org/repo', 1, '', T0 + 7)).toBe('own')
  const row = temp.store.db.query<{ request: string; revision: number; n: number }, []>(
    'SELECT request, revision, repeat_count AS n FROM summaries').get()
  expect(row).toEqual({ request: 'first', revision: 2, n: 2 })
})

test('a prompt without a prompts row keeps the old per-prompt summary', () => {
  const s1 = session('org/repo', 'one')
  expect(write(s1, 'org/repo', 9, 'no prompt row', T0)).toBe('own')
  expect(summaries().map((row) => row.repeatCount)).toEqual([1])
})

test('expired prompt text never matches, even another expired prompt', () => {
  const s1 = session('org/repo', 'one')
  prompt(s1, 1, 'old one', T0)
  prompt(s1, 2, 'old two', T0 + 1)
  expirePromptTexts(temp.store.db, T0 + 10, T0 + 20, 10)
  expect(write(s1, 'org/repo', 1, 'x', T0 + 30)).toBe('own')
  expect(write(s1, 'org/repo', 2, 'y', T0 + 31)).toBe('own')
  expect(summaries()).toHaveLength(2)
  expect(temp.store.db.query('SELECT count(*) AS n FROM prompts WHERE text_hash IS NOT NULL').get()).toEqual({ n: 0 })
})

test('repeatedPromptNumbers names only prompts that repeat a summarized one and have no summary yet', () => {
  const s1 = session('org/repo', 'one')
  const s2 = session('org/repo', 'two')
  prompt(s1, 1, NOTICE, T0)
  prompt(s2, 1, NOTICE, T0 + 1)
  prompt(s2, 2, 'something new', T0 + 2)
  const events = [{ promptNumber: 1 }, { promptNumber: 2 }, { promptNumber: null }, { promptNumber: 1 }]
  expect(repeatedPromptNumbers(temp.store.db, s2, 'org/repo', events)).toEqual([])
  write(s1, 'org/repo', 1, 'first', T0)
  expect(repeatedPromptNumbers(temp.store.db, s2, 'org/repo', events)).toEqual([1])
  expect(repeatedPromptNumbers(temp.store.db, s2, 'org/other', events)).toEqual([])
  expect(repeatedPromptNumbers(temp.store.db, s1, 'org/repo', [{ promptNumber: 1 }])).toEqual([])
})
