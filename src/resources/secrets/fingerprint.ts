// A credential's fingerprint: HMAC-SHA256 under a local key, so the daemon can
// tell that a key changed (and retry events that failed on the old one)
// without storing, logging or comparing the key itself. Without that key a
// fingerprint says nothing about the value; the ref is mixed in so one value
// under two refs gives two fingerprints. Before key rotation the key was hmac.key
// (scheme hmac-sha256); with a Keychain master it is the master's
// fingerprint purpose key (scheme hmac-sha256-m1), which stays the same
// across marker epochs. The scheme prefix lets the reset check tell "the key
// scheme moved" from "the credential changed".

import { createHmac } from 'node:crypto'

/** A missing credential has a fixed marker, so "added a key" reads as a change. */
export const MISSING_CREDENTIAL = 'missing'
/** For a provider that needs no credential (claude-cli uses the user's login). */
export const NO_CREDENTIAL_NEEDED = 'none'
export const LEGACY_FINGERPRINT_SCHEME = 'hmac-sha256'
export const MASTER_FINGERPRINT_SCHEME = 'hmac-sha256-m1'

export interface FingerprintKey {
  key: string
  scheme: string
}

export function credentialFingerprint(hmacKey: string, ref: string, value: string | null, scheme: string = LEGACY_FINGERPRINT_SCHEME): string {
  if (value === null) return MISSING_CREDENTIAL
  const digest = createHmac('sha256', Buffer.from(hmacKey, 'hex')).update(`credential\0${ref}\0`).update(value).digest('hex')
  return `${scheme}:${digest}`
}

/** The scheme of a keyed fingerprint, or null for the fixed markers. */
export function fingerprintScheme(fingerprint: string): string | null {
  const colon = fingerprint.indexOf(':')
  return colon === -1 ? null : fingerprint.slice(0, colon)
}
