import { afterEach, beforeEach, expect, test } from 'bun:test'
import { type TempStore, openTempStore } from '../observer/test-support'
import { upsertProject, upsertSession } from '../store/writes'
import { chooseTerms, recallPrompt } from './recall-reads'
import { seedObservation } from './test-support'

const CWD = '/work/terms-repo'
const T0 = 1_792_900_000_000
let temp: TempStore
let other: number
beforeEach(() => {
  temp = openTempStore('kinfold-recall-reads-')
  upsertProject(temp.store.db, { key: CWD, kind: 'path', displayName: 'terms-repo' }, T0)
  upsertSession(temp.store.db, { host: 'claude-code', hostSessionId: 'me', projectKey: CWD, cwd: CWD, occurredAt: T0 })
  other = upsertSession(temp.store.db, { host: 'opencode', hostSessionId: 'old', projectKey: CWD, cwd: CWD, occurredAt: T0 - 10_000 })
  // "common" is in every memory; "sqlite3mc" and "keychain" in one each.
  for (let index = 0; index < 30; index += 1) seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title: `common note ${index}`, at: T0 - 5_000 })
  seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title: 'common sqlite3mc build', at: T0 - 5_000 })
  seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title: 'common keychain entry', at: T0 - 5_000 })
})
afterEach(() => temp.cleanup())

test('a term in most memories is dropped, and a term in none is too: they cost the most and tell the least', () => {
  expect(chooseTerms(temp.store.db, ['common', 'sqlite3mc', 'unseenword', 'keychain'], 8)).toEqual(['sqlite3mc', 'keychain'])
})

test('the rarest terms are kept past the cap, in the order the prompt gave them', () => {
  expect(chooseTerms(temp.store.db, ['keychain', 'sqlite3mc', 'build', 'entry'], 2)).toEqual(['keychain', 'sqlite3mc'])
})

test('a prompt of common words still keeps its two rarest, so it can match something', () => {
  expect(chooseTerms(temp.store.db, ['common', 'note'], 8)).toEqual(['common', 'note'])
})

test('the recall read answers with the terms it matched on', () => {
  const answer = recallPrompt(temp.store.db, { host: 'claude-code', hostSessionId: 'me', projectKey: CWD, now: T0, terms: ['common', 'sqlite3mc', 'build'], limit: 20 })
  expect(answer.terms).toEqual(['sqlite3mc', 'build'])
  expect(answer.keywordRows.map((row) => row.title)).toEqual(['common sqlite3mc build'])
})

test('a term with an accent is looked up as the index folds it, so it is kept', () => {
  seedObservation(temp.store, { sessionId: other, projectKey: CWD, host: 'opencode', title: 'common café menu', at: T0 - 5_000 })
  expect(chooseTerms(temp.store.db, ['café', 'sqlite3mc'], 8)).toEqual(['café', 'sqlite3mc'])
})
