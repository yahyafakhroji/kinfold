import { expect, test } from 'bun:test'
import { MAX_QUERY_CHARS, MAX_QUERY_TERMS, ftsMatch, parseSearchQuery } from './fts'

test('every term is quoted, inner quotes doubled, so FTS syntax stays literal', () => {
  const parsed = parseSearchQuery('say "hi" NEAR(a b) OR c* col:x')
  expect(parsed).toEqual({ ok: true, terms: ['say', '"hi"', 'NEAR(a', 'b)', 'OR', 'c*', 'col:x'] })
  if (!parsed.ok) throw new Error('unreachable')
  expect(ftsMatch(parsed.terms, 'all')).toBe('"say" """hi""" "NEAR(a" "b)" "OR" "c*" "col:x"')
  expect(ftsMatch(['a', 'b'], 'any')).toBe('"a" OR "b"')
})

test('an empty query, or one with no word characters, is a usage error', () => {
  expect(parseSearchQuery('')).toEqual({ ok: false, error: 'query must not be empty' })
  expect(parseSearchQuery('   ')).toEqual({ ok: false, error: 'query must not be empty' })
  expect(parseSearchQuery('" * ( ) ^ :').ok).toBe(false)
  expect(parseSearchQuery('x'.repeat(MAX_QUERY_CHARS + 1)).ok).toBe(false)
})

test('term count is capped', () => {
  const parsed = parseSearchQuery(Array.from({ length: 40 }, (_, i) => `t${i}`).join(' '))
  expect(parsed.ok && parsed.terms.length).toBe(MAX_QUERY_TERMS)
})
