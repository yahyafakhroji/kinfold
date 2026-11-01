import { expect, test } from 'bun:test'
import { createLateMatches, lateSessionKey } from './late-matches'

const hit = (id: number) => ({ id, distance: 0.3, matchedTerms: 1, promptTerms: 2 })

test('parked hits are taken once, per session', () => {
  const late = createLateMatches()
  late.put(lateSessionKey('claude-code', 'a'), [hit(1)], 0)
  expect(late.take(lateSessionKey('claude-code', 'b'), 1)).toEqual([])
  expect(late.take(lateSessionKey('claude-code', 'a'), 1)).toEqual([hit(1)])
  expect(late.take(lateSessionKey('claude-code', 'a'), 2)).toEqual([])
})

test('a new put replaces the old one, expired hits are dropped, and the oldest session goes past the cap', () => {
  const late = createLateMatches(2, 100)
  late.put('a', [hit(1)], 0)
  late.put('a', [hit(2)], 0)
  expect(late.take('a', 50)).toEqual([hit(2)])
  late.put('a', [hit(3)], 0)
  expect(late.take('a', 101)).toEqual([])
  late.put('x', [hit(4)], 0)
  late.put('y', [hit(5)], 0)
  late.put('z', [hit(6)], 0)
  expect(late.take('x', 1)).toEqual([])
  expect(late.take('z', 1)).toEqual([hit(6)])
})

test('an answer from an older prompt never replaces a newer one, even after a take', () => {
  const late = createLateMatches()
  late.put('a', [hit(2)], 100, 20)
  late.put('a', [hit(1)], 120, 10)
  expect(late.take('a', 130)).toEqual([hit(2)])
  late.put('a', [hit(1)], 140, 10)
  expect(late.take('a', 150)).toEqual([])
  // A newer prompt's empty answer clears older hits.
  late.put('a', [hit(3)], 160, 30)
  late.put('a', [], 170, 40)
  expect(late.take('a', 180)).toEqual([])
})
