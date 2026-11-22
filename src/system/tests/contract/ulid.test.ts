import { describe, expect, test } from 'bun:test'
import { ULID_PATTERN, ulid } from './ulid'

describe('ulid', () => {
  test('produces 26 Crockford base32 characters', () => {
    expect(ulid()).toMatch(ULID_PATTERN)
  })

  test('encodes the timestamp so ids sort by time', () => {
    const zeros = new Uint8Array(10)
    const earlier = ulid(1_700_000_000_000, zeros)
    const later = ulid(1_700_000_000_001, zeros)
    expect(earlier < later).toBe(true)
    expect(ulid(0, zeros)).toBe('0'.repeat(26))
  })

  test('uses all 80 random bits', () => {
    expect(ulid(0, new Uint8Array(10).fill(0xff)).slice(10)).toBe('Z'.repeat(16))
  })

  test('rejects out-of-range input', () => {
    expect(() => ulid(-1)).toThrow(RangeError)
    expect(() => ulid(2 ** 48)).toThrow(RangeError)
    expect(() => ulid(0, new Uint8Array(9))).toThrow(RangeError)
  })
})
