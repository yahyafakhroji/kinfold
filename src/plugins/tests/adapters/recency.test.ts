import { expect, test } from 'bun:test'
import { recent, recentlySeen } from '../../adapters/recency'

test('recent moves a read key to the newest end and leaves a missing key alone', () => {
  const map = new Map([['a', 1], ['b', 2], ['c', 3]])
  expect(recent(map, 'a')).toBe(1)
  expect([...map.keys()]).toEqual(['b', 'c', 'a'])
  expect(recent(map, 'z')).toBeUndefined()
  expect([...map.keys()]).toEqual(['b', 'c', 'a'])
})

test('recentlySeen moves a known key to the newest end and does not add an unknown one', () => {
  const set = new Set(['a', 'b'])
  expect(recentlySeen(set, 'a')).toBe(true)
  expect([...set]).toEqual(['b', 'a'])
  expect(recentlySeen(set, 'z')).toBe(false)
  expect([...set]).toEqual(['b', 'a'])
})
