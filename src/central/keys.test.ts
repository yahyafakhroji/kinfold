import { expect, test } from 'bun:test'
import { type SignedRequest, bodyHash, newKeyPair, signReply, signRequest, verifyReply, verifyRequest } from './keys'

const device = newKeyPair()
const hub = newKeyPair()
const request: SignedRequest = { method: 'POST', path: '/central/capture', deviceId: 'dev-1', time: 1_700_000_000_000, nonce: 'abc', bodySha256: bodyHash('{"a":1}') }

test('a request signed with the device key verifies with its public key', () => {
  const signature = signRequest(device.privateKey, request)
  expect(verifyRequest(device.publicKey, request, signature)).toBe(true)
})

test('changing any signed field, or another key, fails verification', () => {
  const signature = signRequest(device.privateKey, request)
  for (const changed of [
    { ...request, method: 'GET' }, { ...request, path: '/central/import' }, { ...request, deviceId: 'dev-2' },
    { ...request, time: request.time + 1 }, { ...request, nonce: 'abd' }, { ...request, bodySha256: bodyHash('{"a":2}') },
  ]) expect(verifyRequest(device.publicKey, changed, signature)).toBe(false)
  expect(verifyRequest(hub.publicKey, request, signature)).toBe(false)
  expect(verifyRequest(device.publicKey, request, 'garbage')).toBe(false)
  expect(verifyRequest('not a key', request, signature)).toBe(false)
})

test('a reply is bound to the request it answers, its status and its body', () => {
  const requestSignature = signRequest(device.privateKey, request)
  const reply = { requestSignature, status: 200, bodySha256: bodyHash('{"ok":true}') }
  const signature = signReply(hub.privateKey, reply)
  expect(verifyReply(hub.publicKey, reply, signature)).toBe(true)
  expect(verifyReply(hub.publicKey, { ...reply, status: 500 }, signature)).toBe(false)
  expect(verifyReply(hub.publicKey, { ...reply, bodySha256: bodyHash('{}') }, signature)).toBe(false)
  expect(verifyReply(hub.publicKey, { ...reply, requestSignature: 'other' }, signature)).toBe(false)
  expect(verifyReply(device.publicKey, reply, signature)).toBe(false)
})

test('a request signature never verifies as a reply', () => {
  const asRequest = signRequest(hub.privateKey, request)
  expect(verifyReply(hub.publicKey, { requestSignature: '', status: 200, bodySha256: request.bodySha256 }, asRequest)).toBe(false)
})

test('public keys travel as base64 SPKI DER and private keys as PKCS8 PEM', () => {
  expect(Buffer.from(device.publicKey, 'base64').length).toBe(44)
  expect(device.privateKey).toStartWith('-----BEGIN PRIVATE KEY-----')
})
