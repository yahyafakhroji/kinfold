import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { posixOnly } from '../../../../test/platform-guards'
import { AUTO_STATE_FILE, type AutoUpdateState, mergeAutoState, readAutoState } from '../../update/auto-state'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kinfold-auto-state-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const EMPTY: AutoUpdateState = { attempt: null, failure: null, updated: null }
const FULL: AutoUpdateState = {
  attempt: { version: '0.2.1', checkedAt: 1_792_900_000_000, startedAt: 1_792_900_060_000 },
  failure: { version: '0.2.1', at: 1_792_900_090_000, reason: 'the program download answered 503; nothing was changed' },
  updated: { version: '0.2.0', previous: '0.1.9', at: 1_792_000_000_000 },
}

test('a missing file reads as empty', () => {
  expect(readAutoState(dir)).toEqual(EMPTY)
})

test('a merge changes only the parts it names and the rest round-trips', () => {
  mergeAutoState(dir, FULL)
  expect(readAutoState(dir)).toEqual(FULL)
  mergeAutoState(dir, { failure: null })
  expect(readAutoState(dir)).toEqual({ ...FULL, failure: null })
})

posixOnly('file modes')('the file is owner-only', () => {
  mergeAutoState(dir, FULL)
  expect(statSync(join(dir, AUTO_STATE_FILE)).mode & 0o777).toBe(0o600)
})

test('a malformed file, or a malformed part of one, reads as empty and never throws', () => {
  const path = join(dir, AUTO_STATE_FILE)
  for (const text of ['', 'not json', 'null', '[]', '7']) {
    writeFileSync(path, text)
    expect(readAutoState(dir)).toEqual(EMPTY)
  }
  writeFileSync(path, JSON.stringify({ attempt: { version: 5, startedAt: 1 }, failure: { version: '0.2.1', at: 'now', reason: 'x' }, updated: FULL.updated }))
  expect(readAutoState(dir)).toEqual({ ...EMPTY, updated: FULL.updated })
})

test('an attempt made before any successful check keeps a null checkedAt', () => {
  mergeAutoState(dir, { attempt: { version: '0.2.1', checkedAt: null, startedAt: 5 } })
  expect(readAutoState(dir).attempt).toEqual({ version: '0.2.1', checkedAt: null, startedAt: 5 })
  expect(JSON.parse(readFileSync(join(dir, AUTO_STATE_FILE), 'utf8'))).toMatchObject({ attempt: { checkedAt: null } })
})
