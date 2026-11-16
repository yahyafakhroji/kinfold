import { expect, test } from 'bun:test'
import { CODE_PATTERN, deviceProof, hubProof, newInviteCode, normalizeCode, proofKey, verifierFor, verifyDeviceProof, verifyHubProof } from './code'

const SALT = Buffer.alloc(16, 7).toString('base64')

test('an invite code reads KF-XXXX-XXXX in Crockford base32 and two codes differ', () => {
  const a = newInviteCode()
  const b = newInviteCode()
  expect(a).toMatch(CODE_PATTERN)
  expect(a).not.toBe(b)
})

test('a code typed in lower case, with spaces or confusable letters, reads as the same code', () => {
  expect(normalizeCode(' kf-48z1-9tqx ')).toBe('KF-48Z1-9TQX')
  expect(normalizeCode('kf-4821-9tqo')).toBe('KF-4821-9TQ0')
  expect(normalizeCode('KF-482l-9TQX')).toBe('KF-4821-9TQX')
  expect(normalizeCode('KF-4821')).toBeNull()
  expect(normalizeCode('KF-4821-9TQU')).toBeNull()
})

test('the verifier is derived from the code and the salt, and never contains the code', () => {
  const code = 'KF-4821-9TQX'
  const verifier = verifierFor(code, SALT)
  expect(verifier).toBe(verifierFor(code, SALT))
  expect(verifier).not.toBe(verifierFor('KF-4821-9TQY', SALT))
  expect(verifier).not.toContain('4821')
  expect(Buffer.from(verifier, 'base64').length).toBe(32)
})

test('a device proof binds the device key, id and nonce, and only the right code verifies it', () => {
  const key = proofKey(verifierFor('KF-4821-9TQX', SALT))
  const fields = { deviceId: 'dev-abc', devicePublicKey: 'PUB', nonce: 'N1' }
  const proof = deviceProof(key, fields)
  expect(verifyDeviceProof(key, fields, proof)).toBe(true)
  expect(verifyDeviceProof(key, { ...fields, devicePublicKey: 'OTHER' }, proof)).toBe(false)
  expect(verifyDeviceProof(key, { ...fields, nonce: 'N2' }, proof)).toBe(false)
  expect(verifyDeviceProof(key, { ...fields, deviceId: 'dev-x' }, proof)).toBe(false)
  const wrong = proofKey(verifierFor('KF-4821-9TQY', SALT))
  expect(verifyDeviceProof(wrong, fields, proof)).toBe(false)
  expect(verifyDeviceProof(key, fields, 'not-base64!')).toBe(false)
})

test('the hub proof binds the hub key to the device key and cannot be replayed as a device proof', () => {
  const key = proofKey(verifierFor('KF-4821-9TQX', SALT))
  const fields = { hubPublicKey: 'HUB', devicePublicKey: 'PUB', nonce: 'N1' }
  const proof = hubProof(key, fields)
  expect(verifyHubProof(key, fields, proof)).toBe(true)
  expect(verifyHubProof(key, { ...fields, hubPublicKey: 'EVIL' }, proof)).toBe(false)
  expect(verifyDeviceProof(key, { deviceId: 'HUB', devicePublicKey: 'PUB', nonce: 'N1' }, proof)).toBe(false)
})
