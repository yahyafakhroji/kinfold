// Invite codes and the pairing proofs built from them. The hub shows a code
// once; the device types it. The code itself never crosses the wire and is
// never written down: the hub keeps a scrypt verifier, and both sides prove
// they know the code with an HMAC under a key derived from that verifier.
// Each proof names who made it, so the hub's answer cannot be sent back as a
// device's proof, and binds the public key it vouches for, so a key swapped
// in transit fails.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Crockford base32: no I, L, O or U, so a code read aloud or copied by hand survives. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const CODE_PATTERN = /^KF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/

/** Strong enough to slow an offline guess of a 40-bit code, quick enough for one pairing. */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
const VERIFIER_BYTES = 32

export function newInviteCode(): string {
  const bytes = randomBytes(8)
  const chars = Array.from(bytes, (byte) => ALPHABET[byte % 32]!)
  return `KF-${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`
}

/** The code as typed, in canonical form; null when it cannot be a code. Confusable letters read as the digits they look like. */
export function normalizeCode(typed: string): string | null {
  const code = typed.trim().toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1')
  return CODE_PATTERN.test(code) ? code : null
}

export function newSalt(): string {
  return randomBytes(16).toString('base64')
}

/** What the hub keeps instead of the code. */
export function verifierFor(code: string, salt: string): string {
  return scryptSync(code, Buffer.from(salt, 'base64'), VERIFIER_BYTES, SCRYPT).toString('base64')
}

/** The HMAC key both proofs use, derived from the verifier so the verifier itself is never a MAC key. */
export function proofKey(verifier: string): Buffer {
  return createHmac('sha256', Buffer.from(verifier, 'base64')).update('kinfold-central-pair-key-v1').digest()
}

export interface DeviceProofFields {
  deviceId: string
  devicePublicKey: string
  nonce: string
}

export interface HubProofFields {
  hubPublicKey: string
  devicePublicKey: string
  nonce: string
}

function mac(key: Buffer, label: string, parts: readonly string[]): Buffer {
  const hmac = createHmac('sha256', key).update(label)
  // Length-prefixed, so no two different field lists can produce the same input.
  for (const part of parts) hmac.update(`\n${part.length}:${part}`)
  return hmac.digest()
}

function sameMac(expected: Buffer, given: string): boolean {
  const bytes = Buffer.from(given, 'base64')
  return bytes.length === expected.length && timingSafeEqual(bytes, expected)
}

export function deviceProof(key: Buffer, fields: DeviceProofFields): string {
  return mac(key, 'kinfold-central-pair-device-v1', [fields.deviceId, fields.devicePublicKey, fields.nonce]).toString('base64')
}

export function verifyDeviceProof(key: Buffer, fields: DeviceProofFields, proof: string): boolean {
  return sameMac(mac(key, 'kinfold-central-pair-device-v1', [fields.deviceId, fields.devicePublicKey, fields.nonce]), proof)
}

export function hubProof(key: Buffer, fields: HubProofFields): string {
  return mac(key, 'kinfold-central-pair-hub-v1', [fields.hubPublicKey, fields.devicePublicKey, fields.nonce]).toString('base64')
}

export function verifyHubProof(key: Buffer, fields: HubProofFields, proof: string): boolean {
  return sameMac(mac(key, 'kinfold-central-pair-hub-v1', [fields.hubPublicKey, fields.devicePublicKey, fields.nonce]), proof)
}
