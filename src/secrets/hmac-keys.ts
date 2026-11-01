// The HMAC key hierarchy (P1-J). A random 32-byte master lives in the macOS
// Keychain (account hmac-master); only `kinfold install` creates it and only the
// daemon reads it, once at start. Everything else derives from it:
//   marker sub-key for an epoch  = HMAC(master, "marker-ref/v1/" + epoch)
//   credential fingerprint key   = HMAC(master, "credential-fingerprint/v1")
// An epoch is a UTC calendar month written YYYYMM, so a ref says when its key
// was current. Epoch 0 is the pre-P1-J key (the old hmac.key file), kept in
// the Keychain as hmac-legacy. Values here are 64-hex strings, used as
// HMAC keys exactly the way the old hmac.key value was. Pure functions only:
// no Keychain, no files.

import { createHmac } from 'node:crypto'
import type { CredentialProvider } from './credentials'

export const HMAC_MASTER_REF = 'hmac-master'
export const HMAC_LEGACY_REF = 'hmac-legacy'
/** The pre-P1-J key: untagged refs belong to it. */
export const LEGACY_EPOCH = 0
const KEY_PATTERN = /^[0-9a-f]{64}$/
const MARKER_LABEL = 'marker-ref/v1/'
const FINGERPRINT_LABEL = 'credential-fingerprint/v1'

export function isHexKey(value: string): boolean {
  return KEY_PATTERN.test(value)
}

function derive(masterHex: string, label: string): string {
  return createHmac('sha256', Buffer.from(masterHex, 'hex')).update(label).digest('hex')
}

/** The marker key for one epoch (YYYYMM). */
export function markerSubKey(masterHex: string, epoch: number): string {
  if (!isEpoch(epoch)) throw new Error('marker sub-keys exist for YYYYMM epochs only')
  return derive(masterHex, `${MARKER_LABEL}${epoch}`)
}

/** Fingerprints use their own purpose key, so they stay the same across epochs. */
export function fingerprintKey(masterHex: string): string {
  return derive(masterHex, FINGERPRINT_LABEL)
}

// ---- Epochs: UTC months, YYYYMM --------------------------------------------

export function epochAt(ms: number): number {
  const date = new Date(ms)
  return date.getUTCFullYear() * 100 + date.getUTCMonth() + 1
}

export function isEpoch(value: number): boolean {
  const month = value % 100
  return Number.isInteger(value) && value >= 100_001 && month >= 1 && month <= 12
}

/** Start of the epoch, ms since 1970 (UTC). */
export function epochStart(epoch: number): number {
  return Date.UTC(Math.floor(epoch / 100), (epoch % 100) - 1, 1)
}

export function nextEpoch(epoch: number): number {
  return epoch % 100 === 12 ? epoch + 89 : epoch + 1
}

export function previousEpoch(epoch: number): number {
  return epoch % 100 === 1 ? epoch - 89 : epoch - 1
}

// ---- Reading the master (daemon start) -------------------------------------

export type MasterRead =
  | { state: 'present'; master: string }
  | { state: 'missing' }
  /** Locked, denied, timed out or malformed: the master may exist, so nothing may be re-keyed. */
  | { state: 'unavailable'; errorClass: string }

/** "exit_51" for a failed `security` lookup (its messages carry the exit code only), else the error's name. */
export function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown'
  const code = /\(exit (-?\d+)\)/.exec(error.message)?.[1]
  return code !== undefined ? `exit_${code}` : error.name
}

/** Never throws, and the error class is all a caller may log. */
export function readMaster(keychain: CredentialProvider): MasterRead {
  let value: string | null
  try {
    value = keychain.get(HMAC_MASTER_REF)
  } catch (error: unknown) {
    return { state: 'unavailable', errorClass: errorClassOf(error) }
  }
  if (value === null) return { state: 'missing' }
  return isHexKey(value) ? { state: 'present', master: value } : { state: 'unavailable', errorClass: 'malformed' }
}
