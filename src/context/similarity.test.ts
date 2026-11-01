import { expect, test } from 'bun:test'
import { NEAR_DUPLICATE_THRESHOLD, isNearDuplicate, jaccard, nameTokens, stem, titleTokens } from './similarity'

const LIVE_CLAUDE = 'Test suite passes: 197 tests across 16 files'
const LIVE_OPENCODE = 'shared-agent-memory test suite: 197 tests passing across 16 files'
const LIVE_OTHER = 'package.json defines test, typecheck, daemon and hook scripts with no runtime dependencies'

test('punctuation and case are stripped', () => {
  expect([...titleTokens('Spool: DRAIN-order (follows) host-time!')]).toEqual(['spool', 'drain', 'order', 'follow', 'host', 'time'])
})

test('number words become digits, so spelled and written counts match', () => {
  expect(titleTokens('three adapters fail')).toEqual(titleTokens('3 adapters fail'))
  expect(titleTokens('Twenty tests')).toEqual(new Set(['20', 'test']))
})

test('noise words carry no fact and are dropped', () => {
  expect(titleTokens('The route is empty for all of the filters')).toEqual(new Set(['route', 'empty', 'filter']))
})

test('stemming joins plural and verb forms', () => {
  expect(['passes', 'passing', 'passed', 'pass'].map(stem)).toEqual(['pass', 'pass', 'pass', 'pass'])
  expect(['tests', 'files', 'entries', 'class'].map(stem)).toEqual(['test', 'file', 'entry', 'class'])
  expect(stem('is')).toBe('is')
})

test('the live cross-host pair is one fact, with or without the project name ignored', () => {
  expect(jaccard(titleTokens(LIVE_CLAUDE), titleTokens(LIVE_OPENCODE))).toBeGreaterThanOrEqual(NEAR_DUPLICATE_THRESHOLD)
  const ignore = nameTokens('shared-agent-memory')
  expect(jaccard(titleTokens(LIVE_CLAUDE, ignore), titleTokens(LIVE_OPENCODE, ignore))).toBe(1)
})

test('two different facts are not near-duplicates', () => {
  expect(isNearDuplicate(titleTokens(LIVE_CLAUDE), titleTokens(LIVE_OTHER))).toBe(false)
  expect(isNearDuplicate(titleTokens('Spool keeps host event time'), titleTokens('Semantic route returns empty'))).toBe(false)
})

test('empty titles never merge', () => {
  expect(jaccard(titleTokens(''), titleTokens(''))).toBe(0)
  expect(jaccard(titleTokens('the of'), titleTokens('a an'))).toBe(0)
})
