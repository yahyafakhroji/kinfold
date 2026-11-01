import { expect, test } from 'bun:test'
import { MISSING_CREDENTIAL, credentialFingerprint } from './fingerprint'

const KEY = 'ab'.repeat(32)
const OTHER_KEY = 'cd'.repeat(32)
const CREDENTIAL = 'sk-or-v1-0123456789abcdef0123456789abcdef'

test('a fingerprint never equals or contains the credential, or any long piece of it', () => {
  const fingerprint = credentialFingerprint(KEY, 'openrouter', CREDENTIAL)
  expect(fingerprint).not.toBe(CREDENTIAL)
  expect(fingerprint).not.toContain(CREDENTIAL)
  for (let start = 0; start + 8 <= CREDENTIAL.length; start += 1) expect(fingerprint).not.toContain(CREDENTIAL.slice(start, start + 8))
  expect(fingerprint).toMatch(/^hmac-sha256:[0-9a-f]{64}$/)
})

test('stable for the same key, ref and value; different when any of them changes', () => {
  const base = credentialFingerprint(KEY, 'openrouter', CREDENTIAL)
  expect(credentialFingerprint(KEY, 'openrouter', CREDENTIAL)).toBe(base)
  expect(credentialFingerprint(KEY, 'openrouter', `${CREDENTIAL}x`)).not.toBe(base)
  expect(credentialFingerprint(KEY, 'other-ref', CREDENTIAL)).not.toBe(base)
  expect(credentialFingerprint(OTHER_KEY, 'openrouter', CREDENTIAL)).not.toBe(base)
})

test('a missing credential has its own marker, so adding one reads as a change', () => {
  expect(credentialFingerprint(KEY, 'openrouter', null)).toBe(MISSING_CREDENTIAL)
  expect(credentialFingerprint(KEY, 'openrouter', CREDENTIAL)).not.toBe(MISSING_CREDENTIAL)
})
