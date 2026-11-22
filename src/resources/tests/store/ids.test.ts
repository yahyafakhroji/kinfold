import { expect, test } from 'bun:test'
import { parseIds } from '../../store/ids'

test('parseIds keeps safe integers and reads anything else as no ids', () => {
  expect(parseIds('[3, 1, 2]')).toEqual([3, 1, 2])
  expect(parseIds('[1, "2", 1.5, null, 9007199254740993]')).toEqual([1])
  expect(parseIds('{"ids":[1]}')).toEqual([])
  expect(parseIds('not json')).toEqual([])
  expect(parseIds('')).toEqual([])
})
