import { describe, expect, test } from 'bun:test'
import { AdapterInputError, lenient, nonEmpty, str } from '../../adapters/context'

describe('adapter helpers', () => {
  test('str keeps an empty string and nonEmpty drops it', () => {
    expect(str('')).toBe('')
    expect(str('a')).toBe('a')
    expect(str(1)).toBeUndefined()
    expect(str(null)).toBeUndefined()
    expect(nonEmpty('')).toBeUndefined()
    expect(nonEmpty('a')).toBe('a')
    expect(nonEmpty(['a'])).toBeUndefined()
  })

  test('lenient answers null for a payload the parser refuses and rethrows anything else', () => {
    const parse = lenient((value: number): number => {
      if (value === 0) throw new AdapterInputError('no session')
      if (value < 0) throw new RangeError('bug')
      return value * 2
    })
    expect(parse(2)).toBe(4)
    expect(parse(0)).toBeNull()
    expect(() => parse(-1)).toThrow(RangeError)
  })
})
