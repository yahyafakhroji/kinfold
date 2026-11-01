import { expect, test } from 'bun:test'
import { newDbKey } from './keys'
import { RECOVERY_CHARS, RecoveryCodeError, decodeRecoveryCode, encodeRecoveryCode, lastGroup } from './recovery'

test('a code is 55 characters in 11 groups of 5 from the Crockford alphabet, and round-trips to the key', () => {
  for (let i = 0; i < 200; i++) {
    const key = newDbKey()
    const code = encodeRecoveryCode(key)
    expect(RECOVERY_CHARS).toBe(55)
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/)
    expect(decodeRecoveryCode(code)).toBe(key)
    expect(lastGroup(code)).toHaveLength(5)
  }
})

test('decoding forgives case, spacing, dashes and the look-alike letters', () => {
  const key = newDbKey()
  const code = encodeRecoveryCode(key)
  const sloppy = code.toLowerCase().replace(/-/g, ' ').replace(/1/g, 'l').replace(/0/g, 'o')
  expect(decodeRecoveryCode(`  ${sloppy}\n`)).toBe(key)
})

test('a mistyped character, a missing group or a foreign letter is refused, and the error never echoes the code', () => {
  const code = encodeRecoveryCode(newDbKey())
  const first = code[0] === 'A' ? 'B' : 'A'
  const typo = `${first}${code.slice(1)}`
  for (const bad of [typo, code.slice(0, -6), `${code.slice(0, -1)}U`]) {
    let error: unknown
    try {
      decodeRecoveryCode(bad)
    } catch (e: unknown) {
      error = e
    }
    expect(error).toBeInstanceOf(RecoveryCodeError)
    expect((error as Error).message).not.toContain(bad.slice(0, 10))
  }
  expect(() => encodeRecoveryCode('not hex')).toThrow(RecoveryCodeError)
})

test('only the canonical spelling decodes: a last character that differs only in its padding bits is refused', () => {
  const key = newDbKey()
  const code = encodeRecoveryCode(key)
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const last = alphabet.indexOf(code.at(-1)!)
  // The last character holds 2 key bits then 3 padding bits; flip a padding bit.
  const padded = `${code.slice(0, -1)}${alphabet[last ^ 1]}`
  expect(() => decodeRecoveryCode(padded)).toThrow(RecoveryCodeError)
  expect(decodeRecoveryCode(code)).toBe(key)
})
